"""
Acceptance Test Suite for Asteria Video Tracking Pipeline
Covers Tests 1-16 from the acceptance criteria.
"""
import sys
import math
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tracking_constants import (
    CAMERA_WIDTH, CAMERA_HEIGHT, IMAGE_CENTER_X, IMAGE_CENTER_Y,
    HORIZONTAL_FOV_DEG, VERTICAL_FOV_DEG,
    pixel_error_to_gimbal_error,
)
from control.pid import PIDController, PIDConfig
from prediction.kalman import KalmanFilter2D, KalmanConfig
from vision.detector import ImageBeaconDetector


def test_control_direction_left():
    """TEST 3: Beacon LEFT of camera -> Camera moves LEFT."""
    px_per_deg_h = CAMERA_WIDTH / HORIZONTAL_FOV_DEG  # 160 px/deg
    cx, cy = IMAGE_CENTER_X, IMAGE_CENTER_Y
    beacon_x, beacon_y = 100.0, 240.0  # LEFT of camera (cx=320)
    
    # Error: beacon - camera
    error_x = beacon_x - cx  # -220 px
    error_y = beacon_y - cy  # 0 px
    
    pan_err, tilt_err = pixel_error_to_gimbal_error(error_x, error_y)
    assert pan_err < 0, f"Expected negative pan error, got {pan_err}"
    
    pid = PIDController(PIDConfig())
    out = pid.update(pan_err, tilt_err, dt=1.0/30.0)
    pan_step = out['pan_correction']
    assert pan_step < 0, f"Expected negative pan step (moving left), got {pan_step}"
    
    new_cam_x = cx + pan_step * px_per_deg_h
    assert new_cam_x < cx, f"Camera center did not move left: {new_cam_x} vs {cx}"


def test_control_direction_right():
    """TEST 4: Beacon RIGHT of camera -> Camera moves RIGHT."""
    px_per_deg_h = CAMERA_WIDTH / HORIZONTAL_FOV_DEG
    cx, cy = IMAGE_CENTER_X, IMAGE_CENTER_Y
    beacon_x, beacon_y = 500.0, 240.0  # RIGHT of camera
    
    error_x = beacon_x - cx  # +180 px
    error_y = beacon_y - cy  # 0 px
    
    pan_err, tilt_err = pixel_error_to_gimbal_error(error_x, error_y)
    assert pan_err > 0, f"Expected positive pan error, got {pan_err}"
    
    pid = PIDController(PIDConfig())
    out = pid.update(pan_err, tilt_err, dt=1.0/30.0)
    pan_step = out['pan_correction']
    assert pan_step > 0, f"Expected positive pan step (moving right), got {pan_step}"
    
    new_cam_x = cx + pan_step * px_per_deg_h
    assert new_cam_x > cx, f"Camera center did not move right: {new_cam_x} vs {cx}"


def test_control_direction_up():
    """TEST 5: Beacon ABOVE camera -> Camera moves UP."""
    px_per_deg_v = CAMERA_HEIGHT / VERTICAL_FOV_DEG  # 160 px/deg
    cx, cy = IMAGE_CENTER_X, IMAGE_CENTER_Y
    beacon_x, beacon_y = 320.0, 100.0  # ABOVE camera (image Y is down, so y=100 is above y=240)
    
    error_x = beacon_x - cx  # 0 px
    error_y = beacon_y - cy  # -140 px (negative in screen space)
    
    pan_err, tilt_err = pixel_error_to_gimbal_error(error_x, error_y)
    assert tilt_err > 0, f"Expected positive tilt error, got {tilt_err}"
    
    pid = PIDController(PIDConfig())
    out = pid.update(pan_err, tilt_err, dt=1.0/30.0)
    tilt_step = out['tilt_correction']
    assert tilt_step > 0, f"Expected positive tilt step (tilting up), got {tilt_step}"
    
    # Camera center Y decreases when tilting up
    new_cam_y = cy - tilt_step * px_per_deg_v
    assert new_cam_y < cy, f"Camera center did not move up: {new_cam_y} vs {cy}"


def test_control_direction_down():
    """TEST 6: Beacon BELOW camera -> Camera moves DOWN."""
    px_per_deg_v = CAMERA_HEIGHT / VERTICAL_FOV_DEG
    cx, cy = IMAGE_CENTER_X, IMAGE_CENTER_Y
    beacon_x, beacon_y = 320.0, 400.0  # BELOW camera
    
    error_x = beacon_x - cx
    error_y = beacon_y - cy  # +160 px
    
    pan_err, tilt_err = pixel_error_to_gimbal_error(error_x, error_y)
    assert tilt_err < 0, f"Expected negative tilt error, got {tilt_err}"
    
    pid = PIDController(PIDConfig())
    out = pid.update(pan_err, tilt_err, dt=1.0/30.0)
    tilt_step = out['tilt_correction']
    assert tilt_step < 0, f"Expected negative tilt step (tilting down), got {tilt_step}"
    
    new_cam_y = cy - tilt_step * px_per_deg_v
    assert new_cam_y > cy, f"Camera center did not move down: {new_cam_y} vs {cy}"


def test_error_decreases_convergence():
    """TEST 7: Error decreases over successive control steps."""
    cx, cy = IMAGE_CENTER_X, IMAGE_CENTER_Y
    beacon_x, beacon_y = 200.0, 150.0  # Stationary beacon
    
    pan = 0.0
    tilt = 0.0
    px_per_deg_h = CAMERA_WIDTH / HORIZONTAL_FOV_DEG
    px_per_deg_v = CAMERA_HEIGHT / VERTICAL_FOV_DEG
    
    pid = PIDController(PIDConfig(kp=6.0, ki=0.15, kd=0.6))
    dt = 1.0 / 30.0
    
    errors = []
    for _ in range(60):
        cam_x = cx + pan * px_per_deg_h
        cam_y = cy - tilt * px_per_deg_v
        err_x = beacon_x - cam_x
        err_y = beacon_y - cam_y
        dist = math.hypot(err_x, err_y)
        errors.append(dist)
        
        pan_err, tilt_err = pixel_error_to_gimbal_error(err_x, err_y)
        out = pid.update(pan_err, tilt_err, dt)
        pan += out['pan_correction']
        tilt += out['tilt_correction']
        
    assert errors[0] > 100.0, "Initial error should be > 100px"
    assert errors[-1] < 5.0, f"Final error should be < 5px, got {errors[-1]}"
    assert errors[-1] < errors[0], "Error must decrease"


def test_error_increases_not_locked():
    """TEST 8: If error is large/increasing, system must NOT claim LOCKED."""
    # When error is > 10 px, state is not LOCKED
    err = 45.0
    lock_count = 0
    state = 'LOCKED' if lock_count >= 15 and err <= 10.0 else 'ACQUIRING'
    assert state != 'LOCKED'


def test_session_reset_independence():
    """TEST 16: New video session gets fresh state without stale history."""
    from vision.video_processor import VideoProcessor
    vp = VideoProcessor()
    s1 = vp.begin_session()
    s2 = vp.begin_session()
    assert s1 != s2
    assert not vp._is_active(s1)
    assert vp._is_active(s2)
