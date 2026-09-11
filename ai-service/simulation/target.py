"""
FSOC PAT — Virtual Optical Beacon / Target
Simulates a moving optical beacon with configurable trajectory.
"""
import math
import random
import time
from dataclasses import dataclass, field
from typing import Literal

TrajectoryType = Literal['linear', 'sinusoidal', 'circular', 'random_walk', 'figure_8', 'spiral', 'static']

# ── PS169 default-random initial location ──────────────────────────
# Bounds are chosen so a sampled anchor stays inside the SEARCHING sweep
# envelope (pan ±60°, tilt ±20° at ≥250 m depth):
#   |az| = atan2(|x|, z) ≤ atan2(150, 250) ≈ 31°
#   |el| = atan2(|y|, z) ≤ atan2(60, 250)  ≈ 13.5°
# The beacon itself is never sampled — it remains attached to the target
# via beacon_offset in the target's local frame.
RANDOM_INIT_BOUNDS = {
    'x': (-150.0, 150.0),
    'y': (-30.0, 60.0),
    'z': (250.0, 500.0),
}


def random_initial_position(seed=None) -> 'Vec3':
    """Sample a projectable random target anchor.

    Deterministic when `seed` is supplied, random otherwise.
    """
    rng = random.Random(seed)
    return Vec3(
        rng.uniform(*RANDOM_INIT_BOUNDS['x']),
        rng.uniform(*RANDOM_INIT_BOUNDS['y']),
        rng.uniform(*RANDOM_INIT_BOUNDS['z']),
    )


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
    # Beacon spot geometry (PS169-compatible defaults: 640x480, ~10 px spot)
    beacon_size_px: float = 10.0
    beacon_shape: str = 'square'   # 'square' | 'circle'
    beacon_offset: Vec3 = field(default_factory=lambda: Vec3(0.0, 0.0, 0.0))
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
            # Use incremental integration like random_walk so that per-frame
            # noise doesn't get multiplied by total elapsed time and cause
            # large position jumps late in a run.
            if velocity_variation != 0.0:
                noise_x = self._noise()
                noise_y = self._noise()
            else:
                noise_x = noise_y = 0.0
            vx = cfg.velocity.x * (1.0 + velocity_variation * noise_x)
            vy = cfg.velocity.y * (1.0 + velocity_variation * noise_y)
            self._position.x += vx * dt
            self._position.y += vy * dt
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

        elif cfg.trajectory == 'spiral':
            # Outward spiral in the X/Y plane, one full turn per period,
            # radius grows from 15% to 100% of amplitude then wraps.
            omega = 2.0 * math.pi / cfg.period
            frac = (t % cfg.period) / cfg.period if cfg.period > 0 else 0.0
            radius = 0.15 + 0.85 * frac
            ang = omega * t
            prev_x, prev_y = self._position.x, self._position.y
            self._position.x = self._origin.x + cfg.amplitude_h * radius * math.cos(ang)
            self._position.y = self._origin.y + cfg.amplitude_v * radius * math.sin(ang)
            if dt > 0:
                self._velocity.x = (self._position.x - prev_x) / dt
                self._velocity.y = (self._position.y - prev_y) / dt

        elif cfg.trajectory == 'random_walk':
            acc_x = random.gauss(0, 0.5) * (1 + velocity_variation)
            acc_y = random.gauss(0, 0.3) * (1 + velocity_variation)
            self._rw_vx = max(-8, min(8, self._rw_vx + acc_x * dt))
            self._rw_vy = max(-4, min(4, self._rw_vy + acc_y * dt))
            self._position.x += self._rw_vx * dt
            self._position.y += self._rw_vy * dt
            self._velocity.x = self._rw_vx
            self._velocity.y = self._rw_vy
        elif cfg.trajectory == 'static':
            self._position.x = self._origin.x
            self._position.y = self._origin.y
            self._velocity.x = 0.0
            self._velocity.y = 0.0

    def _noise(self) -> float:
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
        self._velocity = Vec3(self.config.velocity.x,
                              self.config.velocity.y,
                              self.config.velocity.z)
        self._t = 0.0
        self._rw_vx = self.config.velocity.x
        self._rw_vy = self.config.velocity.y
        self.visible = True
