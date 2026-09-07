"""
FSOC PAT — Kalman Filter
Constant-velocity 2D Kalman filter tracking beacon pixel position.

State vector:  [x, y, vx, vy]  (pixel position + velocity)
Measurement:   [x, y]          (pixel centroid from detector)

This is a real linear Kalman filter — not a simulation stub.
"""
import math
import numpy as np
from dataclasses import dataclass
from typing import Optional, Tuple


@dataclass
class KalmanConfig:
    process_noise_q: float = 0.5      # Q: how much the target can accelerate per frame
    measurement_noise_r: float = 5.0  # R: pixel measurement uncertainty
    initial_covariance: float = 500.0  # P0: initial state uncertainty


class KalmanFilter2D:
    """
    Linear Kalman filter for 2-D target tracking.

    All operations use numpy for correctness and speed.
    Algorithm follows the standard predict/update cycle.
    """

    def __init__(self, config: KalmanConfig):
        self.config = config
        self._initialized = False

        # State vector [x, y, vx, vy]
        self._x = np.zeros((4, 1), dtype=np.float64)

        # State covariance matrix P (4×4)
        self._P = np.eye(4, dtype=np.float64) * config.initial_covariance

        # Measurement matrix H (2×4)
        self._H = np.array([
            [1, 0, 0, 0],
            [0, 1, 0, 0],
        ], dtype=np.float64)

        # Measurement noise covariance R (2×2)
        self._R = np.eye(2, dtype=np.float64) * config.measurement_noise_r

        # Will be set in predict()
        self._F: Optional[np.ndarray] = None
        self._Q: Optional[np.ndarray] = None

        self._last_prediction = np.zeros((4, 1), dtype=np.float64)
        self._frames_since_detection = 0
        self._converged = False

    # ── Predict step ──────────────────────────────────────────

    def predict(self, dt: float = 1.0 / 30.0) -> Tuple[float, float]:
        """
        Predict state forward by dt seconds.
        Returns predicted (x, y) pixel position.
        """
        if not self._initialized:
            return (self._x[0, 0], self._x[1, 0])

        # State transition matrix F (constant velocity)
        self._F = np.array([
            [1, 0, dt, 0],
            [0, 1, 0, dt],
            [0, 0, 1,  0],
            [0, 0, 0,  1],
        ], dtype=np.float64)

        # Process noise Q
        dt2 = dt * dt
        dt3 = dt2 * dt
        dt4 = dt3 * dt
        q = self.config.process_noise_q
        self._Q = q * np.array([
            [dt4 / 4, 0, dt3 / 2, 0],
            [0, dt4 / 4, 0, dt3 / 2],
            [dt3 / 2, 0, dt2, 0],
            [0, dt3 / 2, 0, dt2],
        ], dtype=np.float64)

        # Predict
        self._x = self._F @ self._x
        self._P = self._F @ self._P @ self._F.T + self._Q
        self._last_prediction = self._x.copy()
        self._frames_since_detection += 1

        return (float(self._x[0, 0]), float(self._x[1, 0]))

    # ── Update step ───────────────────────────────────────────

    def update(self, measurement_x: float, measurement_y: float) -> None:
        """
        Update the filter with a new measurement.
        Initialises the filter if this is the first measurement.
        """
        z = np.array([[measurement_x], [measurement_y]], dtype=np.float64)

        if not self._initialized:
            self._x[0, 0] = measurement_x
            self._x[1, 0] = measurement_y
            self._x[2, 0] = 0.0
            self._x[3, 0] = 0.0
            self._initialized = True
            self._frames_since_detection = 0
            return

        # Innovation (measurement residual)
        y = z - self._H @ self._x

        # Innovation covariance
        S = self._H @ self._P @ self._H.T + self._R

        # Kalman gain
        K = self._P @ self._H.T @ np.linalg.inv(S)

        # Update state and covariance
        self._x = self._x + K @ y
        I = np.eye(4, dtype=np.float64)
        self._P = (I - K @ self._H) @ self._P

        self._frames_since_detection = 0

        # Declare converged once covariance trace drops below threshold
        trace = float(np.trace(self._P))
        self._converged = trace < self.config.initial_covariance * 0.1

    # ── State access ──────────────────────────────────────────

    @property
    def is_initialized(self) -> bool:
        return self._initialized

    @property
    def position(self) -> Tuple[float, float]:
        return (float(self._x[0, 0]), float(self._x[1, 0]))

    @property
    def velocity(self) -> Tuple[float, float]:
        return (float(self._x[2, 0]), float(self._x[3, 0]))

    @property
    def uncertainty(self) -> float:
        """Trace of the state covariance matrix — lower = more confident."""
        return float(np.trace(self._P))

    @property
    def converged(self) -> bool:
        return self._converged

    def state_dict(self) -> dict:
        px, py = self.position
        vx, vy = self.velocity
        # Predicted next position
        pred_x = px + vx * (1.0 / 30.0)
        pred_y = py + vy * (1.0 / 30.0)
        return {
            'position': {'x': round(px, 2), 'y': round(py, 2)},
            'velocity': {'x': round(vx, 3), 'y': round(vy, 3)},
            'predicted_position': {'x': round(pred_x, 2), 'y': round(pred_y, 2)},
            'uncertainty': round(self.uncertainty, 3),
            'converged': self._converged,
        }

    def reset(self) -> None:
        self._initialized = False
        self._x = np.zeros((4, 1), dtype=np.float64)
        self._P = np.eye(4, dtype=np.float64) * self.config.initial_covariance
        self._frames_since_detection = 0
        self._converged = False
