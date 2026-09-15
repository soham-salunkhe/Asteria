"""
FSOC PAT — PID Pan/Tilt Camera Controller
A real discrete-time PID controller computing angular corrections.

Inputs:  pan_error, tilt_error  (degrees)
Outputs: pan_correction, tilt_correction  (degrees to apply this frame)
"""
import time
from dataclasses import dataclass


@dataclass
class PIDConfig:
    # Authoritative PS169 runtime tuning (deg/sec output, integrated with dt).
    # Single source: tracking_constants PID_KP/KI/KD/... — keep in sync.
    kp: float = 6.0               # Proportional gain
    ki: float = 0.15              # Integral gain
    kd: float = 0.6               # Derivative gain
    max_angular_velocity: float = 5.0  # deg/s maximum output (PS169 default)
    settling_threshold: float = 0.05    # degrees — within = settled
    # Derivative low-pass alpha: d_filt = alpha*d_filt + (1-alpha)*d_raw.
    # Pixel-quantized centroids make the raw derivative thrash sign every
    # frame (measured aim limit-cycle ±4 px at 24 fps with kd=0.9); the
    # filter keeps genuine damping while passing sustained moves in ~3
    # frames.  Single source: tracking_constants PID_D_FILTER_ALPHA.
    derivative_filter_alpha: float = 0.7


class PIDAxis:
    """Single-axis PID controller (pan or tilt)."""

    def __init__(self, config: PIDConfig):
        self.config = config
        self._integral: float = 0.0
        self._prev_error: float = 0.0
        self._prev_time: float | None = None
        # Anti-windup clamp
        self._integral_limit: float = 20.0
        # Filtered derivative state (deg/s)
        self._d_filtered: float = 0.0

    def update(self, error: float, dt: float) -> float:
        """
        Compute control output for this axis.
        Returns angular correction in degrees.
        """
        if dt <= 0:
            return 0.0

        cfg = self.config

        # Proportional term
        p_term = cfg.kp * error

        # Integral term (with anti-windup)
        self._integral += error * dt
        self._integral = max(-self._integral_limit,
                             min(self._integral_limit, self._integral))
        i_term = cfg.ki * self._integral

        # Derivative term — low-pass filtered (see config notes)
        d_raw = cfg.kd * (error - self._prev_error) / dt
        self._prev_error = error
        alpha = cfg.derivative_filter_alpha
        self._d_filtered = alpha * self._d_filtered + (1.0 - alpha) * d_raw
        d_term = self._d_filtered

        # Raw output (degrees per second)
        output_rate = p_term + i_term + d_term

        # Clamp to maximum angular velocity
        output_rate = max(-cfg.max_angular_velocity,
                          min(cfg.max_angular_velocity, output_rate))

        # Convert rate to displacement for this frame
        correction = output_rate * dt
        return correction

    def reset(self) -> None:
        self._integral = 0.0
        self._prev_error = 0.0
        self._d_filtered = 0.0

    def reset_integral(self) -> None:
        """Zero the integrator, preserving derivative/prev-error state."""
        self._integral = 0.0

    @property
    def integral(self) -> float:
        return self._integral

    @property
    def derivative(self) -> float:
        return self._prev_error   # approximation


class PIDController:
    """
    Dual-axis (pan + tilt) PID controller for camera alignment.

    Usage:
        pid = PIDController(config)
        correction = pid.update(pan_error, tilt_error, dt)
        camera.apply_correction(*correction, dt)
    """

    def __init__(self, config: PIDConfig):
        self.config = config
        self._pan_axis = PIDAxis(config)
        self._tilt_axis = PIDAxis(config)
        self._settled = False

    def update(self, pan_error: float, tilt_error: float, dt: float) -> dict:
        """
        Compute pan and tilt corrections.
        Returns dict with corrections and controller state.
        """
        pan_corr = self._pan_axis.update(pan_error, dt)
        tilt_corr = self._tilt_axis.update(tilt_error, dt)

        total_error = (pan_error**2 + tilt_error**2) ** 0.5
        self._settled = total_error < self.config.settling_threshold

        return {
            'pan_correction': round(pan_corr, 5),
            'tilt_correction': round(tilt_corr, 5),
            'pan_integral': round(self._pan_axis.integral, 4),
            'tilt_integral': round(self._tilt_axis.integral, 4),
            'pan_derivative': round(self._pan_axis.derivative, 4),
            'tilt_derivative': round(self._tilt_axis.derivative, 4),
            'settled': self._settled,
        }

    def update_config(self, config: PIDConfig) -> None:
        self.config = config
        self._pan_axis.config = config
        self._tilt_axis.config = config

    def coast(self) -> dict:
        """No measurement available: hold position (zero correction)."""
        self._settled = False
        return {
            'pan_correction': 0.0,
            'tilt_correction': 0.0,
            'pan_integral': round(self._pan_axis.integral, 4),
            'tilt_integral': round(self._tilt_axis.integral, 4),
            'pan_derivative': round(self._pan_axis.derivative, 4),
            'tilt_derivative': round(self._tilt_axis.derivative, 4),
            'settled': self._settled,
        }

    def reset(self) -> None:
        self._pan_axis.reset()
        self._tilt_axis.reset()
        self._settled = False

    def reset_integral(self) -> None:
        """Zero the integrator only (episode hygiene — see video loop).

        Transient bias wound during acquisition must not leak into the
        locked episode as a standing drag.  Derivative state is preserved
        so no D-spike follows.
        """
        self._pan_axis.reset_integral()
        self._tilt_axis.reset_integral()
