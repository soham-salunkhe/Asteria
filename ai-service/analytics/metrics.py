"""
FSOC PAT — Performance Metrics
Accumulates per-frame telemetry and computes summary statistics.
"""
import time
from dataclasses import dataclass, field
from typing import Optional
import math


class RunMetrics:
    """
    Running metrics accumulator for a single simulation run.
    All heavy math is deferred to summary() — frame updates are O(1).
    """

    def __init__(self):
        self._start_time: float = time.time()
        self._frame_count: int = 0
        self._frame_times: list[float] = []
        self._processing_times: list[float] = []
        self._angular_errors: list[float] = []
        self._confidences: list[float] = []
        self._lock_frames: int = 0
        self._total_frames: int = 0
        self._acquisition_time: Optional[float] = None
        self._acquisition_frame: Optional[int] = None
        self._first_detection_time: Optional[float] = None
        self._target_states: list[str] = []
        self._lost_count: int = 0
        # Re-acquisition tracking
        self._reacq_start: Optional[float] = None  # sim time when LOST began
        self._reacq_times: list[float] = []         # all re-acq durations

    def update(
        self,
        frame_time: float,
        processing_ms: float,
        angular_error: float,
        confidence: float,
        target_state: str,
        simulation_elapsed: float,
    ) -> None:
        self._frame_count += 1
        self._total_frames += 1
        self._frame_times.append(frame_time)
        self._processing_times.append(processing_ms)
        self._angular_errors.append(angular_error)
        self._confidences.append(confidence)
        self._target_states.append(target_state)

        if target_state == 'LOCKED':
            self._lock_frames += 1

        if target_state in ('DETECTED', 'ACQUIRING', 'TRACKING', 'LOCKED'):
            if self._first_detection_time is None:
                self._first_detection_time = simulation_elapsed

        if target_state in ('TRACKING', 'LOCKED'):
            if self._acquisition_time is None:
                self._acquisition_time = simulation_elapsed

        if target_state == 'LOST':
            self._lost_count += 1
            if self._reacq_start is None:
                self._reacq_start = simulation_elapsed
        elif target_state in ('TRACKING', 'LOCKED') and self._reacq_start is not None:
            # Completed a re-acquisition
            reacq_duration = simulation_elapsed - self._reacq_start
            self._reacq_times.append(reacq_duration)
            self._reacq_start = None

    def current_fps(self) -> float:
        """FPS computed from last 30 frames."""
        recent = self._frame_times[-30:]
        if len(recent) < 2:
            return 0.0
        dt = recent[-1] - recent[0]
        if dt <= 0:
            return 0.0
        return (len(recent) - 1) / dt

    def summary(self) -> dict:
        errors = self._angular_errors or [0.0]
        confs = [c for c in self._confidences if c > 0]
        proc = self._processing_times or [0.0]

        avg_err = sum(errors) / len(errors)
        max_err = max(errors)
        avg_conf = sum(confs) / len(confs) if confs else 0.0
        avg_proc = sum(proc) / len(proc)
        lock_ret = (self._lock_frames / self._total_frames * 100.0
                    if self._total_frames > 0 else 0.0)

        elapsed = time.time() - self._start_time
        fps = self.current_fps()

        return {
            'duration': round(elapsed, 2),
            'avg_fps': round(fps, 1),
            'acquisition_time': round(self._acquisition_time, 3)
                                if self._acquisition_time else None,
            'average_error': round(avg_err, 4),
            'max_error': round(max_err, 4),
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
        errors = self._angular_errors or [0.0]
        confs = [c for c in self._confidences if c > 0]
        return {
            'fps': round(self.current_fps(), 1),
            'processing_ms': round(
                self._processing_times[-1] if self._processing_times else 0, 2),
            'detection_confidence': round(confs[-1] if confs else 0.0, 4),
            'lock_fraction': round(
                self._lock_frames / max(self._total_frames, 1), 4),
            'acquisition_time': round(self._acquisition_time, 3)
                                if self._acquisition_time else None,
            'average_error': round(
                sum(errors[-300:]) / len(errors[-300:]), 4),
            'max_error': round(max(errors), 4),
            'lock_retention': round(
                self._lock_frames / max(self._total_frames, 1) * 100.0, 2),
        }

    def reset(self) -> None:
        self.__init__()
