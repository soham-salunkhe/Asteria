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
from typing import Callable, Awaitable, Optional, Iterator
from dataclasses import dataclass
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
from tracking_constants import (
    TARGET_LOCK_THRESHOLD_PX,
    ACQUIRING_THRESHOLD_PX,
    LOCK_FRAMES_REQUIRED,
    LOST_GRACE_SECONDS,
)


@dataclass(frozen=True)
class VideoFrame:
    """A source frame with its sensor-clock timestamp, never UI time."""
    index: int
    timestamp: float
    image: np.ndarray


class VideoFileFrameSource:
    """FrameSource adapter for MP4 input.

    OpenCV decoding is deliberately decoupled from browser playback.  Every
    decoded frame is yielded in order and receives its deterministic video
    timestamp (frame index / stream FPS), including files whose container
    timestamp metadata is incomplete.
    """
    def __init__(self, path: Path):
        self._cap = cv2.VideoCapture(str(path))
        if not self._cap.isOpened():
            raise RuntimeError(f"Cannot open video: {path}")
        self.fps = self._cap.get(cv2.CAP_PROP_FPS) or 30.0
        self.frame_count = int(self._cap.get(cv2.CAP_PROP_FRAME_COUNT))
        self._index = 0

    def __iter__(self) -> Iterator[VideoFrame]:
        while True:
            ret, image = self._cap.read()
            if not ret:
                return
            timestamp = self._index / self.fps
            yield VideoFrame(self._index + 1, timestamp, image)
            self._index += 1

    def close(self) -> None:
        self._cap.release()


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
        # Same core tracking components (and tuning) as the live loop:
        # KalmanFilter2D + PIDController with the shared defaults, so the
        # benchmark exercises the real pipeline, not a video-only variant.
        self._kalman   = KalmanFilter2D(KalmanConfig(
            process_noise_q=2.0,
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

    def _emit_event(self, level: str, message: str) -> None:
        self._events.append({
            'id': str(uuid.uuid4()),
            'timestamp': time.time(),
            'level': level,
            'message': message,
        })

    def _drain_events(self) -> list:
        evts = list(self._events)
        self._events = []
        return evts

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

        source = VideoFileFrameSource(path)
        fps = source.fps
        total_frames = source.frame_count
        dt = 1.0 / fps

        # Reset per-run state
        self._kalman.reset()
        self._pid.reset()
        self._metrics.reset()
        self._events = []
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
        self._emit_event('info', f'VIDEO PROCESSING STARTED — {run_name}')
        self._emit_event('info', 'SEARCHING FOR BEACON…')

        frame_id  = 0
        elapsed   = 0.0
        target_state = 'SEARCHING'
        prev_state = 'SEARCHING'
        acq_started = False
        missed_frames = 0
        lock_count = 0
        frame_log: list[tuple[dict, int]] = []
        last_payload = None

        LOST_THRESHOLD = max(10, int(fps * LOST_GRACE_SECONDS))
        # Coast horizon mirrors the live loop: ~1 s of Kalman-prediction
        # coast after a dropout before the estimate is dropped.  A single
        # missed video frame must never reset acquisition progress.
        COAST_FRAMES = max(1, int(fps * 1.0))

        try:
            for source_frame in source:
                t0 = time.perf_counter()
                now = time.time()
                frame_id = source_frame.index
                # The tracking clock is the video sensor clock, not browser
                # playback or decoding speed.
                elapsed = source_frame.timestamp
                raw_frame = source_frame.image

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
                    # Raw centroid error is the measured pixel error used by
                    # reporting.  The controller may use the filtered state,
                    # but never a fabricated measurement.
                    meas_x, meas_y = detection.centroid_x, detection.centroid_y
                    meas_px = math.sqrt((meas_x - cx) ** 2 + (meas_y - cy) ** 2)
                    use_x, use_y = self._kalman.position
                elif self._kalman.is_initialized:
                    use_x, use_y = pred_x, pred_y
                    meas_px = None
                else:
                    use_x, use_y = cx, cy
                    meas_px = None
                pan_err  = (use_x - cx) / px_per_deg_h
                tilt_err = -(use_y - cy) / px_per_deg_v
                total_err = math.sqrt(pan_err**2 + tilt_err**2)
                # Keep the measured image error separate from the filtered
                # control error.  Benchmark pixel metrics are always based
                # on the detector centroid, never prediction/filter output.
                raw_err_x = (px - cx) if detection else None
                raw_err_y = (py - cy) if detection else None
                pix_total = meas_px if detection else None

                # ── PID control ──────────────────────────────────
                pid_out = (self._pid.update(pan_err, tilt_err, dt) if detection
                           else self._pid.coast())
                pan  += pid_out['pan_correction']
                tilt += pid_out['tilt_correction']
                pan  = max(-180.0, min(180.0, pan))
                tilt = max(-90.0,  min(90.0, tilt))
                pan_rate  = pid_out['pan_correction']  / dt if dt > 0 else 0
                tilt_rate = pid_out['tilt_correction'] / dt if dt > 0 else 0

                # ── State machine (same pixel-threshold semantics as the
                # live loop: TRACKING/LOCKED mean on-target ≤10 px, so the
                # benchmark pixel stats only ever cover genuine tracking.
                # A lone missed frame coasts on the Kalman prediction and
                # never resets acquisition progress; LOST fires only after
                # the grace period.  LOCKED still needs LOCK_FRAMES_REQUIRED
                # consecutive raw-centroid frames — never forced.
                if detection and meas_px is not None:
                    if meas_px <= TARGET_LOCK_THRESHOLD_PX:
                        lock_count += 1
                    else:
                        lock_count = 0
                    if lock_count >= LOCK_FRAMES_REQUIRED:
                        target_state = 'LOCKED'
                    elif meas_px <= TARGET_LOCK_THRESHOLD_PX:
                        target_state = 'TRACKING'
                    elif meas_px <= ACQUIRING_THRESHOLD_PX:
                        target_state = 'ACQUIRING'
                    else:
                        target_state = 'DETECTED'
                else:
                    lock_count = 0
                    # Coast-to-dropout handover, mirroring the live loop:
                    # after ~1 s without measurements the Kalman prediction
                    # is stale — drop it instead of chasing it forever.
                    if (missed_frames > COAST_FRAMES
                            and self._kalman.is_initialized):
                        self._kalman.reset()
                        self._pid.reset()
                    if missed_frames > LOST_THRESHOLD:
                        target_state = 'LOST'
                        missed_frames = 0
                        self._kalman.reset()  # stale estimate is worthless
                        self._pid.reset()     # avoid windup-driven re-loss
                    elif target_state in ('LOCKED', 'TRACKING', 'ACQUIRING', 'DETECTED'):
                        target_state = 'REACQUIRING'
                    else:
                        target_state = 'SEARCHING'

                # ── Transition events (emitted on change only, mirroring
                # the live loop so the Event Log corroborates the metrics) ──
                if target_state != prev_state:
                    if target_state == 'ACQUIRING' and not acq_started:
                        acq_started = True
                        self._emit_event('info', 'ACQUISITION STARTED')
                    state_events = {
                        'SEARCHING': ('info', 'SEARCHING FOR BEACON'),
                        'DETECTED': ('info', 'BEACON DETECTED'),
                        'ACQUIRING': ('info', 'TARGET ACQUIRING'),
                        'TRACKING': ('success', 'TRACKING STARTED'),
                        'LOCKED': ('success', 'LOCK ACQUIRED — ERROR ≤ 10 PX'),
                        'LOST': ('warning', 'TARGET LOST'),
                        'REACQUIRING': ('warning', 'REACQUISITION STARTED'),
                    }
                    if target_state in state_events:
                        lvl, msg = state_events[target_state]
                        self._emit_event(lvl, msg)
                    if prev_state in ('READY', 'SEARCHING', 'DETECTED', 'ACQUIRING') \
                            and target_state == 'TRACKING':
                        self._emit_event('success', 'ACQUISITION COMPLETE')
                    if prev_state in ('REACQUIRING', 'LOST') \
                            and target_state in ('TRACKING', 'LOCKED'):
                        self._emit_event('success', 'BEACON REACQUIRED — TRACKING RESUMED')
                    prev_state = target_state

                # ── Metrics ──────────────────────────────────────
                t1 = time.perf_counter()
                processing_ms = (t1 - t0) * 1000.0
                self._metrics.update(
                    frame_time=elapsed,
                    processing_ms=processing_ms,
                    angular_error=total_err,
                    confidence=confidence if detected else 0.0,
                    target_state=target_state,
                    simulation_elapsed=elapsed,
                    pixel_error=round(meas_px, 3) if meas_px is not None else None,
                    measured=detected,
                )

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
                            'x': round(raw_err_x, 2) if raw_err_x is not None else None,
                            'y': round(raw_err_y, 2) if raw_err_y is not None else None,
                            'total': round(pix_total, 2) if pix_total is not None else None,
                            'centroid_x': round(px, 2) if detected else None,
                            'centroid_y': round(py, 2) if detected else None,
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
                        'events': self._drain_events(),
                    },
                }

                if self._broadcast:
                    try:
                        await self._broadcast(telemetry)
                    except Exception:
                        pass

                # A complete per-frame log is flushed after processing so
                # SQLite commits cannot distort measured pipeline latency.
                if self._run_id:
                    frame_log.append((telemetry['payload'], frame_id))
                last_payload = telemetry['payload']

                # ── Pace to match video FPS ──────────────────────
                loop_time = time.perf_counter() - t0
                await asyncio.sleep(max(0.0, dt - loop_time))

        finally:
            source.close()
            # Finalise run
            self._emit_event('info',
                             f'VIDEO PROCESSING COMPLETE — {frame_id} FRAMES, FINAL STATE {target_state}')
            # Settle the UI: one final frame carrying the completion event
            # and closing metrics, with an idle status so controls offer a
            # fresh run instead of freezing on 'running'.
            if self._broadcast and last_payload is not None:
                try:
                    final_payload = dict(last_payload)
                    final_payload['sim_status'] = 'idle'
                    final_payload['metrics'] = self._metrics.frame_metrics()
                    final_payload['events'] = self._drain_events()
                    await self._broadcast({'type': 'telemetry', 'payload': final_payload})
                except Exception:
                    pass
            if self._run_id:
                summary = self._metrics.summary()
                try:
                    db.save_telemetry_samples(self._run_id, frame_log)
                    db.complete_run(self._run_id, summary, target_state, 'completed')
                except Exception:
                    pass

        return self._run_id


# ── Module-level singleton ──────────────────────────────────────
video_processor = VideoProcessor()
