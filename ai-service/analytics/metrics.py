"""
FSOC PAT — Performance Metrics
Accumulates per-frame telemetry and computes summary statistics.
"""
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional
import math

# Maximum entries retained in rolling per-frame lists.
# Keeps memory flat and prevents O(N) scans from growing unboundedly.
_MAX_HISTORY = 1000

# PS169 benchmark thresholds
PS169 = {
    'acquisition_s': 2.0,     # Acquisition Time ≤ 2 s
    'tracking_err_px': 10.0,  # Tracking Error ≤ 10 px
    'target_loss_pct': 5.0,   # Target Loss < 5%
    'reacquisition_s': 1.0,   # Re-acquisition Time ≤ 1 s
    'fps': 20.0,              # Processing Speed ≥ 20 FPS
}


class RunMetrics:
    """
    Running metrics accumulator for a single simulation run.
    All heavy math is deferred to summary() — frame updates are O(1).
    """

    def __init__(self):
        self._start_time: float = time.time()
        self._frame_count: int = 0
        # Capped deques — O(1) append, O(1) popleft, fixed memory
        self._frame_times: deque[float] = deque(maxlen=_MAX_HISTORY)
        self._processing_times: deque[float] = deque(maxlen=_MAX_HISTORY)
        self._angular_errors: deque[float] = deque(maxlen=_MAX_HISTORY)
        self._pixel_errors: deque[float] = deque(maxlen=_MAX_HISTORY)
        self._confidences: deque[float] = deque(maxlen=_MAX_HISTORY)
        self._target_states: deque[str] = deque(maxlen=_MAX_HISTORY)
        # Frames with no valid measurement (detection miss / no coast)
        self._missed_measurement_frames: int = 0
        # Unbounded accumulators (scalars only — no O(N) risk)
        self._lock_frames: int = 0
        # A lock is meaningful only while a real image measurement is
        # eligible for tracking.  SEARCHING/ACQUIRING frames are not part of
        # the retention denominator.
        self._eligible_tracking_frames: int = 0
        self._total_frames: int = 0
        self._acquisition_time: Optional[float] = None
        self._acquisition_frame: Optional[int] = None
        self._first_detection_time: Optional[float] = None
        self._lost_count: int = 0
        # Running max tracked as a scalar — no list scan needed
        self._max_angular_error: float = 0.0
        self._max_pixel_error: float = 0.0
        # O(1) RMSE accumulators (PS169 Benchmark-2 explicitly evaluates RMSE)
        # RMSE = sqrt(sum_sq / count) where only TRACKING/LOCKED frames are counted.
        self._sum_sq_pixel_error: float = 0.0
        self._rmse_count: int = 0
        # Re-acquisition tracking
        self._reacq_start: Optional[float] = None  # sim time when LOST began
        self._reacq_times: list[float] = []         # all re-acq durations

    def update(
        self,
        frame_time: float,
        processing_ms: float,
        angular_error: Optional[float],
        confidence: float,
        target_state: str,
        simulation_elapsed: float,
        pixel_error: Optional[float] = None,
        measured: bool = True,
    ) -> None:
        self._frame_count += 1
        self._total_frames += 1
        self._frame_times.append(frame_time)
        self._processing_times.append(processing_ms)
        if angular_error is not None:
            self._angular_errors.append(angular_error)
        # Tracking-phase pixel stats: only frames already in TRACKING/LOCKED
        # count toward tracking error (the acquisition slew is measured by
        # acquisition_time instead). This matches the PS169 separation of
        # "acquisition" vs "tracking" performance.
        if (pixel_error is not None
                and target_state in ('TRACKING', 'LOCKED')):
            self._pixel_errors.append(pixel_error)
            if pixel_error > self._max_pixel_error:
                self._max_pixel_error = pixel_error
            # O(1) RMSE accumulation
            self._sum_sq_pixel_error += pixel_error * pixel_error
            self._rmse_count += 1
        if not measured:
            self._missed_measurement_frames += 1
        self._confidences.append(confidence)
        self._target_states.append(target_state)
        # Maintain running max — O(1), no list scan
        if angular_error is not None and angular_error > self._max_angular_error:
            self._max_angular_error = angular_error

        if target_state == 'LOCKED':
            self._lock_frames += 1
        if measured and target_state in ('TRACKING', 'LOCKED'):
            self._eligible_tracking_frames += 1

        if target_state in ('DETECTED', 'ACQUIRING', 'TRACKING', 'LOCKED'):
            if self._first_detection_time is None:
                self._first_detection_time = simulation_elapsed

        if target_state in ('TRACKING', 'LOCKED'):
            if self._acquisition_time is None:
                # Acquisition starts at the first valid sensor measurement,
                # not video decode, upload, or UI startup time.
                self._acquisition_time = simulation_elapsed - (
                    self._first_detection_time
                    if self._first_detection_time is not None else simulation_elapsed)

        if target_state == 'LOST':
            self._lost_count += 1
            if self._reacq_start is None:
                self._reacq_start = simulation_elapsed
        elif target_state in ('TRACKING', 'LOCKED') and self._reacq_start is not None:
            # Completed a re-acquisition
            reacq_duration = simulation_elapsed - self._reacq_start
            self._reacq_times.append(reacq_duration)
            self._reacq_start = None

    def _pixel_stats(self) -> tuple[Optional[float], Optional[float]]:
        errs = list(self._pixel_errors)
        if not errs:
            return (None, None)
        return (sum(errs) / len(errs), self._max_pixel_error)

    def rmse_px(self) -> Optional[float]:
        """RMSE of pixel tracking error over TRACKING/LOCKED frames.

        PS169 Benchmark-2 evaluates RMSE explicitly. This is O(1) —
        computed from running sum-of-squares, never from stored history.
        Returns None if fewer than 2 qualifying frames have been seen.
        """
        if self._rmse_count < 2:
            return None
        import math
        return math.sqrt(self._sum_sq_pixel_error / self._rmse_count)

    def _loss_pct(self) -> float:
        if self._total_frames == 0:
            return 0.0
        return self._missed_measurement_frames / self._total_frames * 100.0

    def _avg_reacq(self) -> Optional[float]:
        if not self._reacq_times:
            return None
        return sum(self._reacq_times) / len(self._reacq_times)

    def ps169(self) -> dict:
        """PS169 benchmark evaluation — every value measured, never hardcoded."""
        avg_px, max_px = self._pixel_stats()
        loss = self._loss_pct()
        reacq = self._avg_reacq()
        fps = self.current_fps()
        acq = self._acquisition_time
        has_px = avg_px is not None and max_px is not None
        rmse = self.rmse_px()
        return {
            'acquisition_s': {
                'value': round(acq, 3) if acq is not None else None,
                'pass': (acq is not None and acq <= PS169['acquisition_s']),
            },
            'avg_error_px': {
                'value': round(avg_px, 2) if avg_px is not None else None,
                'pass': bool(has_px) and avg_px <= PS169['tracking_err_px'],
            },
            'max_error_px': {
                'value': round(max_px, 2) if max_px is not None else None,
                'pass': bool(has_px) and max_px <= PS169['tracking_err_px'],
            },
            'rmse_px': {
                'value': round(rmse, 2) if rmse is not None else None,
                'pass': rmse is None or rmse <= PS169['tracking_err_px'],
            },
            'target_loss_pct': {
                'value': round(loss, 2),
                'pass': loss < PS169['target_loss_pct'],
            },
            'reacquisition_s': {
                'value': round(reacq, 3) if reacq is not None else None,
                'pass': (reacq is None or reacq <= PS169['reacquisition_s']),
            },
            'fps': {
                'value': round(fps, 1),
                'pass': fps >= PS169['fps'],
            },
        }

    def current_fps(self) -> float:
        """FPS computed from last 30 frames."""
        # deque doesn't support slice notation — convert the tail to a list
        recent = list(self._frame_times)[-30:]
        if len(recent) < 2:
            return 0.0
        dt = recent[-1] - recent[0]
        if dt <= 0:
            return 0.0
        return (len(recent) - 1) / dt

    def summary(self) -> dict:
        errors = list(self._angular_errors) or [0.0]
        confs = [c for c in self._confidences if c > 0]
        proc = list(self._processing_times) or [0.0]

        avg_err = sum(errors) / len(errors)
        max_err = self._max_angular_error
        avg_px, max_px = self._pixel_stats()
        avg_conf = sum(confs) / len(confs) if confs else 0.0
        avg_proc = sum(proc) / len(proc)
        lock_ret = (self._lock_frames / self._eligible_tracking_frames * 100.0
                    if self._eligible_tracking_frames > 0 else 0.0)

        elapsed = time.time() - self._start_time
        fps = self.current_fps()

        return {
            'duration': round(elapsed, 2),
            'avg_fps': round(fps, 1),
            'acquisition_time': round(self._acquisition_time, 3)
                                if self._acquisition_time else None,
            'average_error': round(avg_err, 4),
            'max_error': round(max_err, 4),
            'average_error_px': round(avg_px, 3) if avg_px is not None else None,
            'max_error_px': round(max_px, 3) if max_px is not None else None,
            'rmse_px': (round(self.rmse_px(), 3)
                        if self.rmse_px() is not None else None),
            'target_loss_pct': round(self._loss_pct(), 2),
            'lock_retention': round(lock_ret, 2),
            'avg_processing_ms': round(avg_proc, 2),
            'detection_confidence': round(avg_conf, 4),
            'total_frames': self._total_frames,
            'lost_count': self._lost_count,
            # Re-acquisition metrics (PS4 param 19)
            'reacquisition_count': len(self._reacq_times),
            'avg_reacquisition_time': round(sum(self._reacq_times) / len(self._reacq_times), 3)
                                     if self._reacq_times else None,
            'max_reacquisition_time': round(max(self._reacq_times), 3)
                                     if self._reacq_times else None,
        }

    def frame_metrics(self) -> dict:
        errors = list(self._angular_errors)
        confs = [c for c in self._confidences if c > 0]
        avg_px, _ = self._pixel_stats()
        return {
            'fps': round(self.current_fps(), 1),
            'processing_ms': round(
                self._processing_times[-1] if self._processing_times else 0, 2),
            'detection_confidence': round(confs[-1] if confs else 0.0, 4),
            'lock_fraction': round(
                self._lock_frames / max(self._eligible_tracking_frames, 1), 4),
            'acquisition_time': round(self._acquisition_time, 3)
                                if self._acquisition_time else None,
            'average_error': round(
                sum(errors) / len(errors), 4) if errors else 0.0,
            'max_error': round(self._max_angular_error, 4),
            'average_error_px': round(avg_px, 3) if avg_px is not None else None,
            'max_error_px': round(self._max_pixel_error, 3) if self._pixel_errors else None,
            'rmse_px': (round(self.rmse_px(), 3)
                        if self.rmse_px() is not None else None),
            'target_loss_pct': round(self._loss_pct(), 2),
            'avg_reacquisition_time': (
                round(self._avg_reacq(), 3) if self._avg_reacq() is not None else None),
            'lock_retention': round(
                self._lock_frames / max(self._eligible_tracking_frames, 1) * 100.0, 2),
            'ps169': self.ps169(),
        }

    def reset(self) -> None:
        self.__init__()
        self._max_angular_error = 0.0
