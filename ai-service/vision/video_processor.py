"""
FSOC PAT — Video Processor (Benchmark 2)
Processes an uploaded .mp4 file frame-by-frame through the detection,
Kalman, and PID pipeline — bypassing the virtual PTZ camera — and
streams results via the shared WebSocket broadcast callback.

This satisfies Benchmark Performance-2 which requires:
  "The software needs to bypass its PTZ camera and take this video as
   an input to the coarse pointing system."
"""
import asyncio
import time
import uuid
import math
import numpy as np
from typing import Callable, Awaitable, Optional
from pathlib import Path

try:
    import cv2
    CV2_AVAILABLE = True
except ImportError:
    CV2_AVAILABLE = False

from vision.detector import create_detector
from prediction.kalman import KalmanFilter2D, KalmanConfig
from control.pid import PIDController, PIDConfig
from analytics.metrics import RunMetrics
from database import models as db


class VideoProcessor:
    """
    Processes an uploaded video file through the FSOC tracking pipeline.
    Each frame is:
      1. Converted to grayscale
      2. Centroided (brightest-region detector)
      3. Passed through Kalman filter
      4. PID correction computed
      5. Telemetry emitted via WebSocket
    """

    CAMERA_W = 640
    CAMERA_H = 480

    def __init__(self):
        self._detector = create_detector(use_yolo=False)
        self._kalman   = KalmanFilter2D(KalmanConfig(
            process_noise_q=0.5,
            measurement_noise_r=5.0,
            initial_covariance=500.0,
        ))
        self._pid = PIDController(PIDConfig(
            kp=6.0, ki=0.15, kd=0.6,
            max_angular_velocity=5.0,
            settling_threshold=0.05,
        ))
        self._metrics  = RunMetrics()
        self._run_id: Optional[str] = None
        self._broadcast: Optional[Callable[[dict], Awaitable[None]]] = None

    def set_broadcast(self, fn: Callable[[dict], Awaitable[None]]) -> None:
        self._broadcast = fn

    async def process(self, video_path: str, scenario_name: Optional[str] = None) -> str:
        """
        Run the video through the PAT pipeline.
        Returns the run_id of the completed run.
        """
        if not CV2_AVAILABLE:
            raise RuntimeError("opencv-python is not installed.")

        path = Path(video_path)
        if not path.exists():
            raise FileNotFoundError(f"Video file not found: {path}")

        cap = cv2.VideoCapture(str(path))
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open video: {path}")

        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        dt = 1.0 / fps

        # Reset per-run state
        self._kalman.reset()
        self._pid.reset()
        self._metrics.reset()
        pan  = 0.0
        tilt = 0.0
        pan_rate  = 0.0
        tilt_rate = 0.0

        # Create DB run record
        run_name = scenario_name or f'VIDEO-{path.stem[:20]}'
        self._run_id = db.create_run(
            scenario_id=None,
            scenario_name=run_name,
            env='video_input',
        )

        frame_id  = 0
        elapsed   = 0.0
        target_state = 'SEARCHING'
        missed_frames = 0
        lock_count = 0

        LOST_THRESHOLD = int(fps * 1.0)   # 1 second of misses → LOST

        try:
            while True:
                ret, raw_frame = cap.read()
                if not ret:
                    break

                t0 = time.perf_counter()
                now = time.time()
                frame_id += 1
                elapsed  += dt

                # ── Resize to camera resolution ─────────────────
                h_orig, w_orig = raw_frame.shape[:2]
                if w_orig != self.CAMERA_W or h_orig != self.CAMERA_H:
                    raw_frame = cv2.resize(raw_frame, (self.CAMERA_W, self.CAMERA_H))

                # ── Convert to grayscale for detection ──────────
                gray = cv2.cvtColor(raw_frame, cv2.COLOR_BGR2GRAY)
                frame01 = (gray.astype(np.float32) / 255.0)

                # ── Image-based beacon detection (no ground truth) ──
                t_det0 = time.perf_counter()
                detection = self._detector.detect_frame(frame01)
                det_ms = (time.perf_counter() - t_det0) * 1000.0
                detected = detection is not None
                if detection:
                    px = float(detection.centroid_x)
                    py = float(detection.centroid_y)
                    confidence = float(detection.confidence)
                else:
                    px, py = 0.0, 0.0
                    confidence = 0.0

                # ── Detection result (image-based, may be None) ───
                det_dict = detection.to_dict() if detection else None

                # ── Kalman update ────────────────────────────────
                if detection:
                    self._kalman.update(detection.centroid_x, detection.centroid_y)
                    missed_frames = 0
                else:
                    missed_frames += 1

                pred_x, pred_y = self._kalman.predict(dt)
                kal_dict = self._kalman.state_dict() if self._kalman.is_initialized else None

                # ── Image-space error (pixel → degrees) ──────────
                cx = self.CAMERA_W / 2
                cy = self.CAMERA_H / 2
                FOV_H = 4.0   # degrees, PS169 narrow-FOV camera
                FOV_V = 3.0
                px_per_deg_h = self.CAMERA_W / FOV_H
                px_per_deg_v = self.CAMERA_H / FOV_V

                if detection:
                    use_x, use_y = detection.centroid_x, detection.centroid_y
                    meas_px = math.sqrt((use_x - cx) ** 2 + (use_y - cy) ** 2)
                elif self._kalman.is_initialized:
                    use_x, use_y = pred_x, pred_y
                    meas_px = None
                else:
                    use_x, use_y = cx, cy
                    meas_px = None
                pan_err  = (use_x - cx) / px_per_deg_h
                tilt_err = -(use_y - cy) / px_per_deg_v
                total_err = math.sqrt(pan_err**2 + tilt_err**2)
                pix_total = math.sqrt((use_x - cx) ** 2 + (use_y - cy) ** 2) \
                    if (detection or self._kalman.is_initialized) else None

                # ── PID control ──────────────────────────────────
                pid_out = self._pid.update(pan_err, tilt_err, dt)
                pan  += pid_out['pan_correction']
                tilt += pid_out['tilt_correction']
                pan  = max(-180.0, min(180.0, pan))
                tilt = max(-90.0,  min(90.0, tilt))
                pan_rate  = pid_out['pan_correction']  / dt if dt > 0 else 0
                tilt_rate = pid_out['tilt_correction'] / dt if dt > 0 else 0

                # ── State machine (pixel-based lock, never forced) ──
                if detection and meas_px is not None:
                    if meas_px <= 10.0:
                        lock_count += 1
                    else:
                        lock_count = 0
                    if lock_count >= 15:
                        target_state = 'LOCKED'
                    elif meas_px <= 10.0:
                        target_state = 'TRACKING'
                    elif meas_px <= 40.0:
                        target_state = 'ACQUIRING'
                    else:
                        target_state = 'DETECTED'
                else:
                    lock_count = 0
                    if missed_frames > LOST_THRESHOLD:
                        target_state = 'LOST'
                    elif target_state in ('LOCKED', 'TRACKING', 'ACQUIRING', 'DETECTED'):
                        target_state = 'REACQUIRING'
                    else:
                        target_state = 'SEARCHING'

                # ── Metrics ──────────────────────────────────────
                t1 = time.perf_counter()
                processing_ms = (t1 - t0) * 1000.0
                self._metrics.update(
                    frame_time=now,
                    processing_ms=processing_ms,
                    angular_error=total_err,
                    confidence=confidence if detected else 0.0,
                    target_state=target_state,
                    simulation_elapsed=elapsed,
                    pixel_error=round(meas_px, 3) if meas_px is not None else None,
                    measured=detected,
                )

                # ── DB sample (every 5 frames) ───────────────────
                if frame_id % 5 == 0 and self._run_id:
                    try:
                        db.save_telemetry_sample(self._run_id, {
                            'timestamp': now,
                            'camera': {
                                'pan': round(pan, 3),
                                'tilt': round(tilt, 3),
                                'pan_rate': round(pan_rate, 3),
                                'tilt_rate': round(tilt_rate, 3),
                                'fov_h': FOV_H,
                                'fov_v': FOV_V,
                                'timestamp': now,
                            },
                            'angular_error': {
                                'pan_error': round(pan_err, 4),
                                'tilt_error': round(tilt_err, 4),
                                'total_error': round(total_err, 4),
                            },
                            'metrics': self._metrics.frame_metrics(),
                            'kalman': kal_dict,
                            'target_state': target_state,
                        }, frame_id)
                    except Exception:
                        pass  # non-fatal

                # ── Broadcast telemetry ──────────────────────────
                frame_metrics = self._metrics.frame_metrics()
                telemetry = {
                    'type': 'telemetry',
                    'payload': {
                        'timestamp': now,
                        'frame_id': frame_id,
                        'elapsed': round(elapsed, 3),
                        'sim_status': 'running',
                        'target_state': target_state,
                        'source': 'video_input',
                        'video_progress': round(frame_id / max(total_frames, 1), 3),
                        'target': {
                            'id': 'VIDEO-BEACON',
                            'position': {'x': 0, 'y': 0, 'z': 300},
                            'velocity': {'x': 0, 'y': 0, 'z': 0},
                            'image_position': {'x': round(px, 2), 'y': round(py, 2)} if detected else None,
                            'timestamp': now,
                        },
                        'camera': {
                            'pan': round(pan, 3),
                            'tilt': round(tilt, 3),
                            'pan_rate': round(pan_rate, 3),
                            'tilt_rate': round(tilt_rate, 3),
                            'fov_h': FOV_H,
                            'fov_v': FOV_V,
                            'timestamp': now,
                        },
                        'detection': det_dict,
                        'kalman': kal_dict,
                        'pixel_error': {
                            'x': round(use_x - cx, 2),
                            'y': round(use_y - cy, 2),
                            'total': round(pix_total, 2) if pix_total is not None else None,
                        },
                        'angular_error': {
                            'pan_error': round(pan_err, 4),
                            'tilt_error': round(tilt_err, 4),
                            'total_error': round(total_err, 4),
                        },
                        'pid_output': pid_out,
                        'disturbance': {
                            'dpan': 0, 'dtilt': 0,
                            'noise_scale': 0,
                            'velocity_variation': 0,
                            'total_disturbance_index': 0,
                            'active_count': 0,
                            'current_perturbation': {'x': 0, 'y': 0},
                            'config': {},
                        },
                        'metrics': frame_metrics,
                        'events': [],
                    },
                }

                if self._broadcast:
                    try:
                        await self._broadcast(telemetry)
                    except Exception:
                        pass

                # ── Pace to match video FPS ──────────────────────
                loop_time = time.perf_counter() - t0
                await asyncio.sleep(max(0.0, dt - loop_time))

        finally:
            cap.release()
            # Finalise run
            if self._run_id:
                summary = self._metrics.summary()
                try:
                    db.complete_run(self._run_id, summary, target_state, 'completed')
                except Exception:
                    pass

        return self._run_id


# ── Module-level singleton ──────────────────────────────────────
video_processor = VideoProcessor()
