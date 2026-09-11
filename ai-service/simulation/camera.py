"""
FSOC PAT — Virtual Pan/Tilt Camera
Models a gimballed camera with FOV, resolution, noise, and angular state.
"""
import math
from dataclasses import dataclass, field
from typing import Optional, Tuple
from simulation.target import Vec3


@dataclass
class CameraConfig:
    position: Vec3 = field(default_factory=lambda: Vec3(0.0, 0.0, 0.0))
    fov_h: float = 30.0          # horizontal FOV, degrees
    fov_v: float = 22.5          # vertical FOV, degrees
    resolution_w: int = 640
    resolution_h: int = 480
    fps: float = 30.0
    noise_level: float = 0.02
    platform_motion: str = 'stationary'  # 'stationary' | 'linear' | 'uav_hover' | 'orbital' | 'circular_patrol'
    platform_speed: float = 2.0
    # Constant translation velocity (m/s) for 'linear' platform motion.
    # Integrated incrementally: position += velocity * dt.
    platform_velocity: Vec3 = field(default_factory=lambda: Vec3(2.0, 0.0, 0.0))


class Camera:
    """
    Pan/tilt camera model.

    Angular conventions:
      pan  ∈ [−180, +180] degrees  (azimuth, positive = right / East)
      tilt ∈ [ −90,  +90] degrees  (elevation, positive = up)

    Pixel origin: top-left corner.
    Beam axis pointing direction computed from pan/tilt.
    """

    PAN_LIMIT = 180.0
    TILT_LIMIT = 90.0

    def __init__(self, config: CameraConfig):
        self.config = config
        self._initial_pos = Vec3(config.position.x, config.position.y, config.position.z)
        self._pan: float = 0.0       # degrees
        self._tilt: float = 0.0      # degrees
        self._pan_rate: float = 0.0  # deg/s
        self._tilt_rate: float = 0.0
        self._t: float = 0.0

    def update_platform(self, dt: float) -> None:
        """Update host platform position according to trajectory model."""
        self._t += dt
        t = self._t
        mode = getattr(self.config, 'platform_motion', 'stationary')
        base = self._initial_pos
        spd = getattr(self.config, 'platform_speed', 2.0)

        if mode == 'linear':
            # PS169 mandatory platform motion: constant-velocity translation.
            # Incremental integration (position += velocity * dt) so the
            # platform pose never jumps, regardless of frame timing.
            v = getattr(self.config, 'platform_velocity', Vec3(2.0, 0.0, 0.0))
            p = self.config.position
            self.config.position = Vec3(
                p.x + v.x * dt, p.y + v.y * dt, p.z + v.z * dt)
        elif mode == 'uav_hover':
            # UAV aerodynamic hover drift: small multiaxial harmonic sway
            dx = 6.0 * math.sin(0.4 * t)
            dy = 2.5 * math.cos(0.35 * t)
            dz = 2.0 * math.sin(0.25 * t)
            self.config.position = Vec3(base.x + dx, base.y + dy, base.z + dz)
        elif mode == 'orbital':
            # Satellite LEO pass forward transit
            self.config.position = Vec3(base.x + spd * 3.0 * math.sin(0.15 * t), base.y, base.z)
        elif mode == 'circular_patrol':
            # Host mobile terminal circling patrol
            r = 18.0
            omega = 0.25 * (spd / 2.0)
            self.config.position = Vec3(
                base.x + r * math.cos(omega * t),
                base.y + 2.0 * math.sin(omega * 2 * t),
                base.z + r * math.sin(omega * t)
            )
        else:
            self.config.position = Vec3(base.x, base.y, base.z)

    # ── Pan/tilt ──────────────────────────────────────────────

    @property
    def pan(self) -> float:
        return self._pan

    @property
    def tilt(self) -> float:
        return self._tilt

    @property
    def pan_rate(self) -> float:
        """Last applied pan rate, deg/s."""
        return self._pan_rate

    @property
    def tilt_rate(self) -> float:
        """Last applied tilt rate, deg/s."""
        return self._tilt_rate

    def apply_correction(self, dpan: float, dtilt: float, dt: float) -> None:
        """Apply pan/tilt rate corrections (deg/s * dt)."""
        new_pan = self._pan + dpan
        new_tilt = self._tilt + dtilt
        # Clamp
        self._pan = max(-self.PAN_LIMIT, min(self.PAN_LIMIT, new_pan))
        self._tilt = max(-self.TILT_LIMIT, min(self.TILT_LIMIT, new_tilt))
        self._pan_rate = dpan / dt if dt > 0 else 0.0
        self._tilt_rate = dtilt / dt if dt > 0 else 0.0

    def reset(self) -> None:
        self._pan = 0.0
        self._tilt = 0.0
        self._pan_rate = 0.0
        self._tilt_rate = 0.0
        self._t = 0.0
        self.config.position = Vec3(
            self._initial_pos.x,
            self._initial_pos.y,
            self._initial_pos.z,
        )

    # ── Projection ────────────────────────────────────────────

    def project_world_to_pixel(self, world_pos: Vec3) -> Optional[Tuple[float, float]]:
        """
        Project a world-space position onto the image plane.
        Returns (px, py) in pixel coordinates, or None if behind/outside FOV.
        """
        cam = self.config.position
        # Relative position
        dx = world_pos.x - cam.x
        dy = world_pos.y - cam.y
        dz = world_pos.z - cam.z   # forward distance

        if dz <= 0.01:
            return None  # behind camera

        # Camera optical-axis direction from pan/tilt
        pan_r = math.radians(self._pan)
        tilt_r = math.radians(self._tilt)

        # Direction cosines of optical axis
        ax = math.sin(pan_r) * math.cos(tilt_r)
        ay = math.sin(tilt_r)
        az = math.cos(pan_r) * math.cos(tilt_r)

        # Target direction unit vector
        dist = math.sqrt(dx * dx + dy * dy + dz * dz)
        if dist < 1e-6:
            return None
        tx, ty, tz = dx / dist, dy / dist, dz / dist

        # Angular offset of target from optical axis
        dot = ax * tx + ay * ty + az * tz
        dot = max(-1.0, min(1.0, dot))

        # Angle in the image plane
        # Camera basis: right = up x axis, local-up = axis x right
        # (right-handed, so +pan moves the spot right, +tilt moves it up)
        up = (0.0, 1.0, 0.0)
        right_x = up[1] * az - up[2] * ay
        right_y = up[2] * ax - up[0] * az
        right_z = up[0] * ay - up[1] * ax
        rlen = math.sqrt(right_x**2 + right_y**2 + right_z**2)
        if rlen < 1e-6:
            return None
        right_x /= rlen
        right_y /= rlen
        right_z /= rlen

        # Local up: cross(axis, right)
        lup_x = ay * right_z - az * right_y
        lup_y = az * right_x - ax * right_z
        lup_z = ax * right_y - ay * right_x

        # Project target onto local frame
        ang_h = math.degrees(math.atan2(
            tx * right_x + ty * right_y + tz * right_z, dot))
        ang_v = math.degrees(math.atan2(
            tx * lup_x + ty * lup_y + tz * lup_z, dot))

        half_h = self.config.fov_h / 2.0
        half_v = self.config.fov_v / 2.0

        if abs(ang_h) > half_h or abs(ang_v) > half_v:
            return None   # outside FOV

        # Normalise to pixel coordinates
        px = (ang_h / half_h + 1.0) / 2.0 * self.config.resolution_w
        py = (1.0 - (ang_v / half_v + 1.0) / 2.0) * self.config.resolution_h
        return (px, py)

    def angular_error_to_target(self, world_pos: Vec3) -> Tuple[float, float]:
        """
        Return (pan_error, tilt_error) in degrees — the angular offset the
        camera must traverse to centre the target on the optical axis.
        """
        cam = self.config.position
        dx = world_pos.x - cam.x
        dy = world_pos.y - cam.y
        dz = world_pos.z - cam.z

        if dz <= 0:
            return (0.0, 0.0)

        # True azimuth / elevation to target
        target_pan = math.degrees(math.atan2(dx, dz))
        target_tilt = math.degrees(math.atan2(dy, math.sqrt(dx**2 + dz**2)))

        pan_err = target_pan - self._pan
        tilt_err = target_tilt - self._tilt
        return (pan_err, tilt_err)

    def state_dict(self, timestamp: float) -> dict:
        return {
            'pan': round(self._pan, 4),
            'tilt': round(self._tilt, 4),
            'pan_rate': round(self._pan_rate, 4),
            'tilt_rate': round(self._tilt_rate, 4),
            'fov_h': self.config.fov_h,
            'fov_v': self.config.fov_v,
            'platform_motion': getattr(self.config, 'platform_motion', 'stationary'),
            'position': self.config.position.as_dict(),
            'timestamp': timestamp,
        }
