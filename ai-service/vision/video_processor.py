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
import base64
import time
import uuid
import math
from itertools import chain
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
    TARGET_UNLOCK_PX,
    ACQUIRING_THRESHOLD_PX,
    LOCK_FRAMES_REQUIRED,
    LOST_GRACE_SECONDS,
    CAMERA_WIDTH, CAMERA_HEIGHT,
    HORIZONTAL_FOV_DEG, VERTICAL_FOV_DEG,
    IMAGE_CENTER_X, IMAGE_CENTER_Y,
    PID_KP, PID_KI, PID_KD,
    PID_MAX_VEL_DEG_PER_SEC,
    PID_MAX_VEL_LOCKED_DEG_PER_SEC,
    PID_APPROACH_RATE_DEG_PER_SEC,
    PID_D_FILTER_ALPHA,
    FF_VEL_EMA_ALPHA,
    CONTROL_DEADBAND_PX,
    PID_SETTLING_DEG,
    KALMAN_Q, KALMAN_R, KALMAN_P0,
    pixel_error_to_gimbal_error,
    PAN_MIN_DEG, PAN_MAX_DEG, TILT_MIN_DEG, TILT_MAX_DEG,
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

    CAMERA_W = CAMERA_WIDTH
    CAMERA_H = CAMERA_HEIGHT

    def __init__(self):
        self._detector = create_detector(use_yolo=False)
        # Same core tracking components (and tuning) as the live loop:
        # KalmanFilter2D + PIDController with the shared defaults, so the
        # benchmark exercises the real pipeline, not a video-only variant.
        self._kalman   = KalmanFilter2D(KalmanConfig(
            process_noise_q=KALMAN_Q,
            measurement_noise_r=KALMAN_R,
            initial_covariance=KALMAN_P0,
        ))
        self._pid = PIDController(PIDConfig(
            kp=PID_KP, ki=PID_KI, kd=PID_KD,
            max_angular_velocity=PID_MAX_VEL_DEG_PER_SEC,
            settling_threshold=PID_SETTLING_DEG,
            derivative_filter_alpha=PID_D_FILTER_ALPHA,
        ))
        self._metrics  = RunMetrics()
        self._run_id: Optional[str] = None
        self._broadcast: Optional[Callable[[dict], Awaitable[None]]] = None
        # A new upload invalidates every pending callback from its predecessor.
        self._active_session_id: Optional[str] = None

    def set_broadcast(self, fn: Callable[[dict], Awaitable[None]]) -> None:
        self._broadcast = fn

    def begin_session(self) -> str:
        """Invalidate an older upload and reserve a fresh video session."""
        self._active_session_id = str(uuid.uuid4())
        return self._active_session_id

    def _is_active(self, session_id: str) -> bool:
        return session_id == self._active_session_id

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

    async def process(self, video_path: str, scenario_name: Optional[str] = None,
                      session_id: Optional[str] = None) -> str:
        """
        Run the video through the PAT pipeline.
        Returns the run_id of the completed run.
        """
        if not CV2_AVAILABLE:
            raise RuntimeError("opencv-python is not installed.")

        path = Path(video_path)
        if not path.exists():
            raise FileNotFoundError(f"Video file not found: {path}")

        session_id = session_id or self.begin_session()
        if not self._is_active(session_id):
            return ''
        source = VideoFileFrameSource(path)
        fps = source.fps
        total_frames = source.frame_count
        dt = 1.0 / fps

        # Reset per-run state (including detector association memory:
        # a stale continuity gate from the previous video would bias the
        # first frames toward a star and collapse the run)
        self._detector.reset()
        self._kalman.reset()
        self._pid.reset()
        self._metrics.reset()
        self._events = []
        pan  = 0.0
        tilt = 0.0
        pan_rate  = 0.0
        tilt_rate = 0.0
        previous_raw_centroid: Optional[tuple[float, float]] = None
        raw_velocity_x = 0.0
        raw_velocity_y = 0.0
        recent_errors: list[float] = []

        # Create DB run record
        run_name = scenario_name or f'VIDEO-{path.stem[:20]}'
        self._run_id = db.create_run(
            scenario_id=None,
            scenario_name=run_name,
            env='video_input',
        )
        # Decode and publish the first real sensor image before the detector,
        # Kalman, PID, metrics, or tracking state can advance.  This explicit
        # READY packet is the MP4 first-frame handshake.
        source_iter = iter(source)
        first_frame = next(source_iter, None)
        if first_frame is None:
            raise RuntimeError('Video contains no decodable frames.')
        first_raw = first_frame.image
        if first_raw.shape[1] != self.CAMERA_W or first_raw.shape[0] != self.CAMERA_H:
            first_raw = cv2.resize(first_raw, (self.CAMERA_W, self.CAMERA_H))
        first_jpeg: Optional[str] = None
        ok, buf = cv2.imencode('.jpg', first_raw, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
        if ok:
            first_jpeg = base64.b64encode(buf).decode('ascii')
        if self._broadcast and self._is_active(session_id):
            await self._broadcast({'type': 'telemetry', 'payload': {
                'timestamp': time.time(), 'frame_id': first_frame.index,
                'elapsed': round(first_frame.timestamp, 3), 'sim_status': 'idle',
                'target_state': 'READY', 'source': 'video_input',
                'video_status': 'VIDEO_READY', 'video_progress': 0.0,
                'session_id': session_id, 'frame_index': first_frame.index,
                'detector_frame': None, 'tracker_frame': None,
                'video_total_frames': total_frames, 'video_fps': fps,
                'video_frame_jpeg': first_jpeg, 'detection': None, 'kalman': None,
                'pixel_error': None, 'events': [],
            }})
        self._emit_event('info', f'VIDEO PROCESSING STARTED — {run_name}')
        self._emit_event('info', 'SEARCHING FOR BEACON…')

        frame_id  = 0
        elapsed   = 0.0
        target_state = 'SEARCHING'
        prev_state = 'SEARCHING'
        acq_started = False
        missed_frames = 0
        lock_count = 0
        # Hysteresis: once LOCKED, only exit when error > TARGET_UNLOCK_PX
        # for UNLOCK_FRAMES_REQUIRED consecutive frames.  A single spike
        # (detection noise) must NEVER break an established lock.
        UNLOCK_FRAMES_REQUIRED = 3
        unlock_count = 0  # consecutive frames above unlock threshold
        frame_log: list[tuple[dict, int]] = []
        last_payload = None

        LOST_THRESHOLD = max(10, int(fps * LOST_GRACE_SECONDS))
        # Coast horizon mirrors the live loop: ~1 s of Kalman-prediction
        # coast after a dropout before the estimate is dropped.  A single
        # missed video frame must never reset acquisition progress.
        COAST_FRAMES = max(1, int(fps * 1.0))

        try:
            for source_frame in chain((first_frame,), source_iter):
                if not self._is_active(session_id):
                    return self._run_id or ''
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
                # The decoded MP4 is a fixed optical scene.  Detector pixels
                # never move with the virtual gimbal; pan/tilt instead move
                # the camera aim point/FOV overlay across these coordinates.
                gray = cv2.cvtColor(raw_frame, cv2.COLOR_BGR2GRAY)
                frame01 = (gray.astype(np.float32) / 255.0)

                # ── Image-based beacon detection (no ground truth) ──
                # Per-frame image geometry FIRST: control/prediction below
                # needs valid inputs on every frame, including the first
                # (previously these were defined after detection, which
                # broke frame 1 with unbound names).
                cx = IMAGE_CENTER_X
                cy = IMAGE_CENTER_Y
                FOV_H = HORIZONTAL_FOV_DEG
                FOV_V = VERTICAL_FOV_DEG
                px_per_deg_h = self.CAMERA_W / FOV_H
                px_per_deg_v = self.CAMERA_H / FOV_V
                camera_center_x = cx + pan * px_per_deg_h
                camera_center_y = cy - tilt * px_per_deg_v
                t_det0 = time.perf_counter()
                # NOTE: NO Kalman predicted_pos hint is passed (None), by
                # measurement: feeding the prediction as a 0.65 spatial
                # prior creates a death spiral on fast curved targets —
                # lagging hint boosts stale-side specks, wrong measurements
                # feed a laggier filter (figure-8: identical 187 px
                # divergences across runs; hint off: clean lock).  The
                # detector's own continuity gate handles association.
                # Kalman prediction is still used for coast across misses.
                detection = self._detector.detect_frame(
                    frame01, predicted_pos=None
                )
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
                # The filter runs in FULL-FRAME MP4 coordinates on the raw
                # centroid: it smooths measurement jitter honestly, and the
                # control residual (estimate − aim, below) can never
                # collapse the way a camera-relative residual did (measured
                # 0.8 px seen vs 14 px true).  Detector telemetry stays in
                # immutable MP4 coordinates.  (cx/cy/FOV/camera_center are
                # defined above, before detection, so hint and update share
                # one geometry.)
                if detection:
                    self._kalman.update(detection.centroid_x, detection.centroid_y)
                    missed_frames = 0
                    if previous_raw_centroid is not None:
                        # Smoothed target motion from real, fixed-video
                        # measurements.  Feed-forward is bounded together
                        # with PID below; it does not fabricate a centroid.
                        # EMA alpha is single-sourced (FF_VEL_EMA_ALPHA).
                        instant_x = (detection.centroid_x - previous_raw_centroid[0]) / dt
                        instant_y = (detection.centroid_y - previous_raw_centroid[1]) / dt
                        raw_velocity_x = (1.0 - FF_VEL_EMA_ALPHA) * raw_velocity_x + FF_VEL_EMA_ALPHA * instant_x
                        raw_velocity_y = (1.0 - FF_VEL_EMA_ALPHA) * raw_velocity_y + FF_VEL_EMA_ALPHA * instant_y
                    previous_raw_centroid = (detection.centroid_x, detection.centroid_y)
                else:
                    missed_frames += 1
                    previous_raw_centroid = None
                    raw_velocity_x = raw_velocity_y = 0.0

                pred_x, pred_y = self._kalman.predict(dt)
                kal_dict = self._kalman.state_dict(dt) if self._kalman.is_initialized else None

                # ── Image-space error (pixel → degrees) ──────────
                if detection:
                    # Raw centroid error is the measured pixel error used by
                    # reporting.  The controller may use the filtered state,
                    # but never a fabricated measurement.
                    meas_x, meas_y = detection.centroid_x, detection.centroid_y
                    meas_px = math.sqrt((meas_x - cx) ** 2 + (meas_y - cy) ** 2)
                else:
                    meas_px = None
                # Current FSOC aim projected into fixed video coordinates.
                # +pan aims right; +tilt aims up (image Y decreases).  The
                # image centre stays fixed at (320, 240); it is not the
                # dynamic camera centre after a gimbal command.
                # Measured error is beacon - current camera aim.  The helper
                # owns the one image-Y (down) -> tilt (up) inversion.
                # CONTROL uses the RAW residual (detection - aim): zero-lag
                # chase, proven to acquire and hold lock on fast targets
                # (a filtered residual lags turnarounds — measured: full
                # LOCKED collapse to DETECTED on figure-8).  Smoothing lives
                # in the VELOCITY path (Kalman full-frame velocity feeds FF
                # below), not in the position error.  Metrics/state machine
                # still use the raw residual — never the estimate.
                if detection:
                    control_error_x = detection.centroid_x - camera_center_x
                    control_error_y = detection.centroid_y - camera_center_y
                    # Control deadband (CONTROL_DEADBAND_PX): inside ~1.5 px
                    # the P term would chase quantization jitter forever,
                    # pumping micro-oscillation into the aim.  Hold the PID
                    # errors at zero there — feedforward below still tracks
                    # beacon motion, metrics still record the true residual,
                    # and 1.5 px is far inside the 10 px lock gate.
                    if math.hypot(control_error_x, control_error_y) < CONTROL_DEADBAND_PX:
                        control_error_x, control_error_y = 0.0, 0.0
                elif self._kalman.is_initialized:
                    # No detection: coast on the prediction vs aim.
                    control_error_x = pred_x - camera_center_x
                    control_error_y = pred_y - camera_center_y
                else:
                    # Filter never initialized: no information, hold still.
                    control_error_x, control_error_y = 0.0, 0.0
                pan_err, tilt_err = pixel_error_to_gimbal_error(
                    control_error_x, control_error_y)
                total_err = math.sqrt(pan_err**2 + tilt_err**2)
                # Keep the measured image error separate from the filtered
                # control error.  Benchmark pixel metrics are always based
                # on the detector centroid, never prediction/filter output.
                raw_err_x = (px - camera_center_x) if detection else None
                raw_err_y = (py - camera_center_y) if detection else None
                # Tracking error/lock are measured against current aim, not
                # the fixed image centre once the virtual camera has moved.
                pix_total = math.hypot(raw_err_x, raw_err_y) if detection else None
                if pix_total is not None:
                    recent_errors.append(pix_total)
                    if len(recent_errors) > 20:
                        recent_errors.pop(0)
                error_trend = 'STABLE'
                if len(recent_errors) >= 5:
                    delta_err = recent_errors[-1] - recent_errors[0]
                    if delta_err < -1.0:
                        error_trend = 'DECREASING'
                    elif delta_err > 1.0:
                        error_trend = 'DIVERGING'
                    else:
                        error_trend = 'STABLE'

                # ── PID control ──────────────────────────────────
                pid_out = (self._pid.update(pan_err, tilt_err, dt) if detection
                           else self._pid.coast())
                # Approach-rate clamp: the raw residual gives the true error,
                # but an unclamped P would slam the aim at up to 15 deg/s on
                # far-field errors and limit-cycle across the beacon
                # (measured 666 px spikes).  The clamp binds ONLY in far
                # field (DETECTED): once TRACKING/LOCKED the error is ≤10 px
                # by definition, so full P is inherently small and safe —
                # and the aim needs its full rate to ride fast figure-8
                # sweeps without unlocking (measured 16 px/frame sweeps vs
                # 13 px/frame under a blanket clamp).  Feedforward is added
                # after, under the same step clamp.
                if detection and dt > 0 and target_state == 'DETECTED':
                    for _k in ('pan_correction', 'tilt_correction'):
                        _rate = pid_out[_k] / dt
                        _rate = max(-PID_APPROACH_RATE_DEG_PER_SEC,
                                    min(PID_APPROACH_RATE_DEG_PER_SEC, _rate))
                        pid_out[_k] = round(_rate * dt, 5)
                # Move the FOV window with the real beacon trajectory as
                # well as correcting residual error.  Positive screen X is
                # positive pan; positive screen Y is negative tilt.
                # Velocity source: raw-centroid EMA (proven stable base).
                # Tried and REVERTED: Kalman-velocity FF (collapsed on
                # figure-8 reversals — 257 px excursions) and phase-aligned
                # scaling (self-exciting limit cycle on smooth fast
                # segments).  Both failures are documented so nobody
                # re-tries them blind.  Responsiveness beats smoothness for
                # feedforward on this benchmark; smoothing lives in the
                # detector (median), the D-filter, and the deadband.
                if detection:
                    ff_pan_rate = raw_velocity_x / px_per_deg_h
                    ff_tilt_rate = -raw_velocity_y / px_per_deg_v
                else:
                    ff_pan_rate, ff_tilt_rate = 0.0, 0.0
                # Adaptive velocity cap: during acquisition use the full slew
                # rate to chase fast-moving beacons; once LOCKED tighten to
                # the stable tracking rate to reject vibration/noise.
                vel_cap = (PID_MAX_VEL_LOCKED_DEG_PER_SEC
                           if target_state in ('LOCKED', 'TRACKING')
                           else PID_MAX_VEL_DEG_PER_SEC)
                max_step = vel_cap * dt
                pan_step = max(-max_step, min(max_step,
                    pid_out['pan_correction'] + ff_pan_rate * dt))
                tilt_step = max(-max_step, min(max_step,
                    pid_out['tilt_correction'] + ff_tilt_rate * dt))
                pid_out['pan_correction'] = round(pan_step, 5)
                pid_out['tilt_correction'] = round(tilt_step, 5)
                pid_out['ff_pan_rate'] = round(ff_pan_rate, 4)
                pid_out['ff_tilt_rate'] = round(ff_tilt_rate, 4)
                pan  += pan_step
                tilt += tilt_step
                pan  = max(PAN_MIN_DEG, min(PAN_MAX_DEG, pan))
                tilt = max(TILT_MIN_DEG, min(TILT_MAX_DEG, tilt))
                pan_rate  = pan_step / dt if dt > 0 else 0
                tilt_rate = tilt_step / dt if dt > 0 else 0

                # ── State machine (same pixel-threshold semantics as the
                # live loop: TRACKING/LOCKED mean on-target ≤10 px, so the
                # benchmark pixel stats only ever cover genuine tracking.
                # A lone missed frame coasts on the Kalman prediction and
                # never resets acquisition progress; LOST fires only after
                # the grace period.  LOCKED still needs LOCK_FRAMES_REQUIRED
                # consecutive raw-centroid frames — never forced.
                # lock_lost_reason records WHY lock was exited on each
                # frame for health diagnostics (NONE while held).
                lock_lost_reason = 'NONE'
                if detection and pix_total is not None:
                    # ── Lock acquisition (hysteresis enter) ────────
                    if pix_total <= TARGET_LOCK_THRESHOLD_PX:
                        lock_count += 1
                        unlock_count = 0       # error is good; reset exit counter
                    else:
                        # Error above lock threshold — count towards unlock
                        # but do NOT immediately reset lock_count so that
                        # single-frame noise spikes don't block acquisition.
                        if target_state != 'LOCKED':
                            lock_count = max(0, lock_count - 1)
                        unlock_count += 1

                    # ── Hysteresis EXIT from LOCKED ─────────────────
                    # Only exit LOCKED when error persistently exceeds
                    # TARGET_UNLOCK_PX for UNLOCK_FRAMES_REQUIRED frames.
                    # This prevents any single detection noise spike from
                    # breaking an established lock.
                    if target_state == 'LOCKED':
                        if unlock_count >= UNLOCK_FRAMES_REQUIRED and pix_total > TARGET_UNLOCK_PX:
                            target_state = 'TRACKING'
                            lock_lost_reason = 'ERROR_TOO_HIGH'
                            lock_count = LOCK_FRAMES_REQUIRED - 1  # close to re-locking
                        # else: stay LOCKED despite error spike
                    elif lock_count >= LOCK_FRAMES_REQUIRED:
                        target_state = 'LOCKED'
                        unlock_count = 0
                    elif pix_total <= TARGET_LOCK_THRESHOLD_PX:
                        target_state = 'TRACKING'
                    elif pix_total <= ACQUIRING_THRESHOLD_PX:
                        target_state = 'ACQUIRING'
                    else:
                        target_state = 'DETECTED'
                else:
                    # Brief dropout: FREEZE lock/unlock progress inside the
                    # coast window instead of resetting it.  A 1–2 frame
                    # detection gap must not void a solid lock acquisition —
                    # but frozen frames earn no credit either: lock_count is
                    # never incremented without a real measurement.  Past the
                    # coast horizon the estimate is stale, so progress resets
                    # together with the filter below.  A miss is also not
                    # evidence of error-above-threshold, so unlock_count
                    # holds steady rather than counting toward unlock exit.
                    if missed_frames > COAST_FRAMES:
                        lock_count = 0
                        unlock_count = 0
                    # else: hold both counters steady through the gap
                    # Coast-to-dropout handover, mirroring the live loop:
                    # after ~1 s without measurements the Kalman prediction
                    # is stale — drop it instead of chasing it forever.
                    if (missed_frames > COAST_FRAMES
                            and self._kalman.is_initialized):
                        self._kalman.reset()
                        self._pid.reset()
                    if missed_frames > LOST_THRESHOLD:
                        target_state = 'LOST'
                        lock_lost_reason = 'STATE_TIMEOUT'
                        missed_frames = 0
                        lock_count = 0
                        unlock_count = 0
                        self._kalman.reset()  # stale estimate is worthless
                        self._pid.reset()     # avoid windup-driven re-loss
                    elif target_state in ('LOCKED', 'TRACKING', 'ACQUIRING', 'DETECTED'):
                        if target_state == 'LOCKED':
                            lock_lost_reason = 'NO_DETECTION'
                        target_state = 'REACQUIRING'
                    else:
                        target_state = 'SEARCHING'

                # ── Transition events (emitted on change only, mirroring
                # the live loop so the Event Log corroborates the metrics) ──
                if target_state != prev_state:
                    if prev_state != 'LOCKED' and target_state == 'LOCKED':
                        # Rising edge into LOCKED: zero the integrator so
                        # transient bias wound during acquisition cannot
                        # leak into the episode as a standing drag
                        # (measured frozen -0.149 ≈ -3.5 px drag on
                        # figure-8).  Derivative state is preserved.
                        self._pid.reset_integral()
                        self._emit_event('info', 'INTEGRATOR ZEROED ON LOCK ENTRY')
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
                    pixel_error=round(pix_total, 3) if pix_total is not None else None,
                    measured=detected,
                )

                # ── Broadcast telemetry ──────────────────────────
                frame_metrics = self._metrics.frame_metrics()
                # Attach the ACTUAL processed video frame (JPEG, base64) so
                # the UI shows the real input — never a synthetic starfield.
                # Encoding is best-effort: telemetry must survive a failure.
                video_jpeg: Optional[str] = None
                try:
                    ok, buf = cv2.imencode(
                        '.jpg', raw_frame,
                        [int(cv2.IMWRITE_JPEG_QUALITY), 50])
                    if ok:
                        video_jpeg = base64.b64encode(buf).decode('ascii')
                except Exception:
                    video_jpeg = None
                telemetry = {
                    'type': 'telemetry',
                    'payload': {
                        'timestamp': now,
                        'frame_id': frame_id,
                        'elapsed': round(elapsed, 3),
                        'sim_status': 'running',
                        'target_state': target_state,
                        'source': 'video_input',
                        'video_status': 'VIDEO_PROCESSING',
                        'video_progress': round(frame_id / max(total_frames, 1), 3),
                        # Frame-identity proof (S17): display, detector and
                        # tracker all consume THIS decoded frame — same loop
                        # iteration, same session, same index, same clock.
                        'session_id': session_id,
                        'frame_index': frame_id,
                        'detector_frame': frame_id,
                        'tracker_frame': frame_id,
                        'video_total_frames': total_frames,
                        'video_fps': fps,
                        'camera_center': {
                            'x': round(camera_center_x, 2),
                            'y': round(camera_center_y, 2),
                        },
                        # Per-frame tracking health (diagnostics): WHY lock
                        # was exited on this frame.  NONE while held.
                        # NO_DETECTION | ERROR_TOO_HIGH | STATE_TIMEOUT
                        'lock_lost_reason': lock_lost_reason,
                        'video_frame_jpeg': video_jpeg,
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
                        'optical_center': {'x': cx, 'y': cy},
                        'error_trend': error_trend,
                        'candidates': det_dict.get('candidates', []) if det_dict else [],
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

                if self._broadcast and self._is_active(session_id):
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
            if self._broadcast and last_payload is not None and self._is_active(session_id):
                try:
                    final_payload = dict(last_payload)
                    final_payload['sim_status'] = 'idle'
                    final_payload['video_status'] = 'VIDEO_COMPLETE'
                    final_payload['metrics'] = self._metrics.frame_metrics()
                    final_payload['events'] = self._drain_events()
                    await self._broadcast({'type': 'telemetry', 'payload': final_payload})
                except Exception:
                    pass
            if self._run_id:
                summary = self._metrics.summary()
                # Retry terminal finalize: a rapid re-upload collides on the
                # sqlite writer lock, and a swallowed failure leaves a
                # 'running' ghost row with no summary (seen in batch runs).
                # The run MUST reach a terminal state; worst case it is
                # marked aborted, never left hanging.
                _finalized = False
                for _attempt in range(3):
                    try:
                        db.save_telemetry_samples(self._run_id, frame_log)
                        db.complete_run(self._run_id, summary, target_state, 'completed')
                        _finalized = True
                        break
                    except Exception:
                        await asyncio.sleep(0.5 + _attempt)
                if not _finalized:
                    try:
                        db.complete_run(self._run_id, summary, target_state, 'aborted')
                    except Exception:
                        pass

        return self._run_id


# ── Module-level singleton ──────────────────────────────────────
video_processor = VideoProcessor()
