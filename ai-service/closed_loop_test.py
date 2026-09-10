"""
Headless closed-loop verification for the FSOC PAT pipeline.
Mirrors engine._loop order EXACTLY (no WebSocket, no DB):
  target → beacon pos → project → render → detect_frame → Kalman →
  pixel error → PID + inertial feedforward → camera → state machine → metrics
PASS criteria mirror PS169: acquisition ≤2s, tracking avg/max err ≤10px,
loss <5%, stable LOCKED.
"""
import math
import statistics
import sys
import numpy as np

from simulation.target import Target, TargetConfig, Vec3
from simulation.camera import Camera, CameraConfig
from simulation.disturbances import DisturbanceEngine
from prediction.kalman import KalmanFilter2D, KalmanConfig
from control.pid import PIDController, PIDConfig
from vision.detector import ImageBeaconDetector
from vision.frame_renderer import FrameRenderer
from analytics.metrics import RunMetrics


def run_case(name, traj, init, vel, amp_h=8.0, amp_v=5.0, period=14.0,
             steps=900, noise=0.0, seed=11):
    W, H, FOV_H, FOV_V, FPS = 640, 480, 4.0, 3.0, 30.0
    dt = 1.0 / FPS
    rng = np.random.default_rng(seed)
    target = Target(TargetConfig(
        id='BEACON-01', initial_position=Vec3(*init), velocity=Vec3(*vel),
        trajectory=traj, amplitude_h=amp_h, amplitude_v=amp_v, period=period,
        beacon_size_px=10.0, beacon_shape='square'))
    cam = Camera(CameraConfig(fov_h=FOV_H, fov_v=FOV_V,
                              resolution_w=W, resolution_h=H, fps=FPS))
    dist = DisturbanceEngine()
    if noise > 0:
        dist.config.sensor_noise.enabled = True
        dist.config.sensor_noise.noise_level = noise
    kalman = KalmanFilter2D(KalmanConfig(process_noise_q=2.0))
    pid = PIDController(PIDConfig(kp=6.0, ki=0.15, kd=0.6,
                                  max_angular_velocity=5.0,
                                  settling_threshold=0.05))
    det = ImageBeaconDetector('BEACON-01', 10.0)
    renderer = FrameRenderer(W, H)
    metrics = RunMetrics()

    state, missed, lock_count = 'SEARCHING', 0, 0
    cx, cy = W / 2.0, H / 2.0
    max_corr = 0.0

    for i in range(steps):
        t = (i + 1) * dt
        cam.update_platform(dt)
        d = dist.update(dt)
        target.update(dt, d['velocity_variation'])
        p = target.position
        proj = cam.project_world_to_pixel(p)
        vis = proj is not None
        img = renderer.render(
            proj[0] if proj else None, proj[1] if proj else None,
            visible=vis, size_px=10.0, intensity=0.95, shape='square',
            noise_type='gaussian', noise_level=d['noise_level'],
            turb_strength=0.0, rng=rng)
        detection = det.detect_frame(img)
        if detection:
            kalman.update(detection.centroid_x, detection.centroid_y)
            missed = 0
            mx, my = detection.centroid_x, detection.centroid_y
            meas = math.hypot(mx - cx, my - cy)
        else:
            missed += 1
            if kalman.is_initialized:
                mx, my = kalman.predict(dt)
                meas = None
            else:
                kalman.predict(dt)
                mx, my, meas = None, None, None
        if mx is not None:
            pan_err = (mx - cx) * (FOV_H / W)
            tilt_err = -(my - cy) * (FOV_V / H)
            out = pid.update(pan_err, tilt_err, dt)
            ff_pan, ff_tilt = 0.0, 0.0
            if kalman.is_initialized:
                kvx, kvy = kalman.velocity
                ff_pan = cam.pan_rate + kvx * (FOV_H / W)
                ff_tilt = cam.tilt_rate - kvy * (FOV_V / H)
            dp = out['pan_correction'] + ff_pan * dt
            dq = out['tilt_correction'] + ff_tilt * dt
            s = math.hypot(dp, dq)
            ms = 5.0 * dt
            if s > ms:
                dp *= ms / s
                dq *= ms / s
            max_corr = max(max_corr, math.hypot(dp, dq) / dt)
            cam.apply_correction(dp, dq, dt)
            ang = math.hypot(pan_err, tilt_err)
        else:
            out = pid.coast()
            ang = 0.0
        # state machine (mirror of engine)
        if detection and meas is not None:
            lock_count = lock_count + 1 if meas <= 10.0 else 0
            if lock_count >= 15:
                state = 'LOCKED'
            elif meas <= 10.0:
                state = 'TRACKING'
            elif meas <= 40.0:
                state = 'ACQUIRING'
            else:
                state = 'DETECTED'
        else:
            lock_count = 0
            if missed > int(FPS * 1.0):
                state = 'LOST'
            elif state in ('LOCKED', 'TRACKING', 'ACQUIRING', 'DETECTED'):
                state = 'REACQUIRING'
            else:
                state = 'SEARCHING'
        metrics.update(frame_time=t, processing_ms=0.4,
                       angular_error=ang,
                       confidence=detection.confidence if detection else 0.0,
                       target_state=state, simulation_elapsed=t,
                       pixel_error=round(meas, 3) if meas is not None else None,
                       measured=detection is not None)

    ps = metrics.ps169()
    ok = (ps['acquisition_s']['pass'] and ps['avg_error_px']['pass']
          and ps['max_error_px']['pass'] and ps['target_loss_pct']['pass']
          and state == 'LOCKED' and max_corr <= 5.0 + 1e-9)
    print(f'--- {name} ---')
    for k, v in ps.items():
        print(f"  {k:16s} {str(v['value']):>10s}  {'PASS' if v['pass'] else 'FAIL'}")
    print(f'  final={state} max_rate={round(max_corr,2)}deg/s => {"PASS" if ok else "FAIL"}')
    return ok


if __name__ == '__main__':
    results = [
        run_case('TEST1 straight', 'linear', (-8, 2, 350), (6, 0.3, 0)),
        run_case('TEST2 circular', 'circular', (0, 2, 350), (0, 0, 0)),
        run_case('TEST3 figure-8', 'figure_8', (0, 2, 350), (0, 0, 0)),
        run_case('TEST4 random', 'random_walk', (0, 2, 350), (1.0, 0.3, 0), steps=1200),
        run_case('TEST1 + noise 0.05', 'linear', (-8, 2, 350), (6, 0.3, 0), noise=0.05),
    ]
    print('OVERALL:', 'PASS' if all(results) else 'FAIL')
    sys.exit(0 if all(results) else 1)
