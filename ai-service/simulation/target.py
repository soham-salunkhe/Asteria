"""
FSOC PAT — Virtual Optical Beacon / Target
Simulates a moving optical beacon with configurable trajectory.
"""
import math
import time
from dataclasses import dataclass, field
from typing import Literal

TrajectoryType = Literal['linear', 'sinusoidal', 'circular', 'random_walk', 'figure_8']


@dataclass
class Vec3:
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0

    def as_dict(self) -> dict:
        return {'x': self.x, 'y': self.y, 'z': self.z}

    def __add__(self, other: 'Vec3') -> 'Vec3':
        return Vec3(self.x + other.x, self.y + other.y, self.z + other.z)

    def __mul__(self, scalar: float) -> 'Vec3':
        return Vec3(self.x * scalar, self.y * scalar, self.z * scalar)


@dataclass
class TargetConfig:
    id: str = 'BEACON-01'
    initial_position: Vec3 = field(default_factory=lambda: Vec3(100.0, 50.0, 200.0))
    velocity: Vec3 = field(default_factory=lambda: Vec3(2.0, 0.5, 0.0))
    trajectory: TrajectoryType = 'sinusoidal'
    intensity: float = 0.95   # beacon luminance 0-1
    # Sinusoidal / circular parameters
    amplitude_h: float = 80.0   # metres
    amplitude_v: float = 40.0   # metres
    period: float = 20.0        # seconds


class Target:
    """
    Simulates a moving optical beacon.

    All positions are in a right-handed world coordinate system:
      +X = East, +Y = Up, +Z = North (towards camera).
    """

    def __init__(self, config: TargetConfig):
        self.config = config
        self.id = config.id
        self._origin = Vec3(config.initial_position.x,
                            config.initial_position.y,
                            config.initial_position.z)
        self._position = Vec3(config.initial_position.x,
                              config.initial_position.y,
                              config.initial_position.z)
        self._velocity = Vec3(config.velocity.x,
                              config.velocity.y,
                              config.velocity.z)
        self._t = 0.0   # simulation time in seconds
        # Random-walk state
        self._rw_vx = config.velocity.x
        self._rw_vy = config.velocity.y
        # Whether this beacon is visible (active)
        self.visible: bool = True

    # ── Update ────────────────────────────────────────────────

    def update(self, dt: float, velocity_variation: float = 0.0) -> None:
        """Advance target by dt seconds."""
        if not self.visible:
            return

        self._t += dt
        t = self._t
        cfg = self.config

        if cfg.trajectory == 'linear':
            vx = cfg.velocity.x * (1.0 + velocity_variation * self._noise())
            vy = cfg.velocity.y * (1.0 + velocity_variation * self._noise())
            self._position.x = self._origin.x + vx * t
            self._position.y = self._origin.y + vy * t
            self._velocity.x = vx
            self._velocity.y = vy

        elif cfg.trajectory == 'sinusoidal':
            omega = 2.0 * math.pi / cfg.period
            self._position.x = (self._origin.x
                                 + cfg.amplitude_h * math.sin(omega * t))
            self._position.y = (self._origin.y
                                 + cfg.amplitude_v * math.sin(2 * omega * t + 0.5))
            # True instantaneous velocity (derivative of position)
            self._velocity.x = cfg.amplitude_h * omega * math.cos(omega * t)
            self._velocity.y = cfg.amplitude_v * 2 * omega * math.cos(2 * omega * t + 0.5)

        elif cfg.trajectory == 'circular':
            omega = 2.0 * math.pi / cfg.period
            self._position.x = self._origin.x + cfg.amplitude_h * math.cos(omega * t)
            self._position.y = self._origin.y + cfg.amplitude_v * math.sin(omega * t)
            # True instantaneous velocity
            self._velocity.x = -cfg.amplitude_h * omega * math.sin(omega * t)
            self._velocity.y =  cfg.amplitude_v * omega * math.cos(omega * t)

        elif cfg.trajectory == 'figure_8':
            # Lissajous figure-8: x = A·sin(ωt), y = B·sin(2ωt + π/2)
            # Produces a smooth, closed infinity-symbol path.
            omega = 2.0 * math.pi / cfg.period
            self._position.x = self._origin.x + cfg.amplitude_h * math.sin(omega * t)
            self._position.y = self._origin.y + cfg.amplitude_v * math.sin(2 * omega * t + math.pi / 2)
            # True instantaneous velocity (derivative)
            self._velocity.x = cfg.amplitude_h * omega * math.cos(omega * t)
            self._velocity.y = cfg.amplitude_v * 2 * omega * math.cos(2 * omega * t + math.pi / 2)

        elif cfg.trajectory == 'random_walk':
            import random
            acc_x = random.gauss(0, 0.5) * (1 + velocity_variation)
            acc_y = random.gauss(0, 0.3) * (1 + velocity_variation)
            self._rw_vx = max(-8, min(8, self._rw_vx + acc_x * dt))
            self._rw_vy = max(-4, min(4, self._rw_vy + acc_y * dt))
            self._position.x += self._rw_vx * dt
            self._position.y += self._rw_vy * dt
            self._velocity.x = self._rw_vx
            self._velocity.y = self._rw_vy

    def _noise(self) -> float:
        import random
        return random.gauss(0, 0.1)

    # ── Properties ────────────────────────────────────────────

    @property
    def position(self) -> Vec3:
        return self._position

    @property
    def velocity(self) -> Vec3:
        return self._velocity

    def state_dict(self, timestamp: float) -> dict:
        return {
            'id': self.id,
            'position': self._position.as_dict(),
            'velocity': self._velocity.as_dict(),
            'image_position': {'x': 0.0, 'y': 0.0},  # filled by camera
            'timestamp': timestamp,
        }

    def reset(self) -> None:
        self._position = Vec3(self.config.initial_position.x,
                              self.config.initial_position.y,
                              self.config.initial_position.z)
        self._t = 0.0
        self.visible = True
