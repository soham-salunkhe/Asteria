"""
FSOC PAT — Virtual Pan/Tilt Camera
Models a gimballed camera with FOV, resolution, noise, and angular state.
"""
import math
from dataclasses import dataclass, field
from typing import Optional, Tuple
from simulation.target import Vec3

try:
    from tracking_constants import (
        CAMERA_WIDTH, CAMERA_HEIGHT,
        HORIZONTAL_FOV_DEG, VERTICAL_FOV_DEG, CAMERA_FPS,
        PAN_MIN_DEG, PAN_MAX_DEG, TILT_MIN_DEG, TILT_MAX_DEG,
        optical_forward as _opt_fwd,
        boresight_deg as _boresight,
    )
except ImportError:  # standalone use without package root
    CAMERA_WIDTH, CAMERA_HEIGHT = 640, 480
    HORIZONTAL_FOV_DEG, VERTICAL_FOV_DEG, CAMERA_FPS = 4.0, 3.0, 30.0
    PAN_MIN_DEG, PAN_MAX_DEG, TILT_MIN_DEG, TILT_MAX_DEG = -180.0, 180.0, -89.0, 89.0
    _opt_fwd = None  # type: ignore
    _boresight = None  # type: ignore


@dataclass
class CameraConfig:
    position: Vec3 = field(default_factory=lambda: Vec3(0.0, 0.0, 0.0))
    fov_h: float = HORIZONTAL_FOV_DEG   # horizontal FOV, degrees (PS169: 4)
    fov_v: float = VERTICAL_FOV_DEG     # vertical FOV, degrees (PS169: 3)
    resolution_w: int = CAMERA_WIDTH    # PS169: 640
    resolution_h: int = CAMERA_HEIGHT   # PS169: 480
    fps: float = CAMERA_FPS
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
      tilt ∈ [ −89,  +89] degrees  (elevation, positive = up;
             89 deg safe limit avoids the +/-90 deg gimbal singularity)

    Pixel origin: top-left corner. Image centre: (320, 240) at 640x480.
    Beam axis pointing direction computed from pan/tilt.
    """

    PAN_LIMIT = 180.0
    TILT_LIMIT = 89.0

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

    def set_angles(self, pan: float, tilt: float) -> None:
        """Absolute positioning for operator manual control.

        Unlike apply_correction, this places the gimbal exactly at the
        commanded angles and zeroes the rate estimates so the next
        feedforward step does not inherit a huge phantom velocity from
        a large manual jump (dpan/dt).
        """
        self._pan = max(-self.PAN_LIMIT, min(self.PAN_LIMIT, float(pan)))
        self._tilt = max(-self.TILT_LIMIT, min(self.TILT_LIMIT, float(tilt)))
        self._pan_rate = 0.0
        self._tilt_rate = 0.0

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

        The world offset is first rotated into the CAMERA frame (inverse of
        the pan/tilt gimbal rotation, YXZ yaw-then-pitch).  The behind test
        uses camera-space forward depth, so targets behind the WORLD +Z
        plane are still projectable whenever the gimbal actually faces
        them — only targets truly behind the optical aperture return None.
        Sign conventions (+pan = right/East, +tilt = up) match the previous
        implementation exactly for the forward hemisphere.
        """
        cam = self.config.position
        # Relative position in world axes
        dx = world_pos.x - cam.x
        dy = world_pos.y - cam.y
        dz = world_pos.z - cam.z

        dist = math.sqrt(dx * dx + dy * dy + dz * dz)
        if dist < 1e-6:
            return None  # coincident with the aperture

        pan_r = math.radians(self._pan)
        tilt_r = math.radians(self._tilt)

        # Inverse gimbal rotation R^-1 = Rx(+tilt) · Ry(-pan): world offset
        # → camera-space offset (x right, y up, z forward along the axis).
        cp = math.cos(pan_r)
        sp = math.sin(pan_r)
        x1 = cp * dx - sp * dz
        z1 = sp * dx + cp * dz
        y1 = dy
        ct = math.cos(tilt_r)
        st = math.sin(tilt_r)
        x2 = x1
        y2 = ct * y1 - st * z1
        z2 = st * y1 + ct * z1

        if z2 <= 0.01:
            return None  # genuinely behind the optical aperture

        ang_h = math.degrees(math.atan2(x2, z2))
        ang_v = math.degrees(math.atan2(y2, z2))

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

        Uses the full camera-frame projection so the result is consistent with
        project_world_to_pixel.  When the target is behind the optical
        aperture (camera-space z ≤ 0) a large directional error is returned
        so the search sweep is driven toward the correct hemisphere rather
        than receiving a zero signal that halts all motion.
        """
        cam = self.config.position
        dx = world_pos.x - cam.x
        dy = world_pos.y - cam.y
        dz = world_pos.z - cam.z

        dist = math.sqrt(dx * dx + dy * dy + dz * dz)
        if dist < 1e-6:
            return (0.0, 0.0)

        pan_r  = math.radians(self._pan)
        tilt_r = math.radians(self._tilt)

        # Inverse gimbal rotation R^-1 = Rx(+tilt) · Ry(-pan)
        cp = math.cos(pan_r);  sp = math.sin(pan_r)
        x1 =  cp * dx - sp * dz
        z1 =  sp * dx + cp * dz
        y1 = dy
        ct = math.cos(tilt_r); st = math.sin(tilt_r)
        # x2 = x1 (unchanged)
        y2 =  ct * y1 - st * z1
        z2 =  st * y1 + ct * z1

        if z2 <= 0.0:
            # Target is behind the optical aperture.  Return a large error
            # whose sign indicates the correct hemisphere to pan/tilt toward.
            # This drives the deterministic search sweep rather than producing
            # a zero signal that freezes all camera motion.
            pan_err  = math.copysign(120.0, x1)
            tilt_err = math.copysign(60.0,  y2 if y2 != 0.0 else y1)
            return (pan_err, tilt_err)

        pan_err  = math.degrees(math.atan2(x1, z2))
        tilt_err = math.degrees(math.atan2(y2, z2))
        return (pan_err, tilt_err)

    def optical_forward(self) -> Tuple[float, float, float]:
        """Unit forward vector of the FSOC optical axis (never zero-length)."""
        if _opt_fwd is not None:
            return _opt_fwd(self._pan, self._tilt)
        p, t = math.radians(self._pan), math.radians(self._tilt)
        return (math.sin(p) * math.cos(t), math.sin(t), math.cos(p) * math.cos(t))

    def beacon_relative(self, world_pos: Vec3) -> Tuple[Tuple[float, float, float], bool, bool]:
        """Return (unit direction to beacon, in_front, in_fov).

        in_front: beacon strictly ahead of the optical aperture (cam-space z > 0).
        in_fov: inside the 4x3 deg frustum AND projectable to a valid pixel.
        """
        dx = world_pos.x - self.config.position.x
        dy = world_pos.y - self.config.position.y
        dz = world_pos.z - self.config.position.z
        dist = math.sqrt(dx * dx + dy * dy + dz * dz)
        if dist < 1e-9:
            return ((0.0, 0.0, 1.0), False, False)
        direction = (dx / dist, dy / dist, dz / dist)
        fwd = self.optical_forward()
        in_front = (fwd[0] * direction[0] + fwd[1] * direction[1]
                    + fwd[2] * direction[2]) > 0 and self.project_world_to_pixel(world_pos) is not None
        # project_world_to_pixel already enforces behind + FOV clip
        proj = self.project_world_to_pixel(world_pos)
        in_fov = proj is not None
        # in_front must be the pure geometric hemisphere test (dot > 0),
        # independent of the narrow FOV clip, so SEARCHING diagnostics
        # distinguish "behind camera" from "ahead but outside FOV".
        dot = fwd[0] * direction[0] + fwd[1] * direction[1] + fwd[2] * direction[2]
        return (direction, dot > 0.0, in_fov)

    def boresight_to(self, world_pos: Vec3) -> Optional[float]:
        """Angular separation (deg) between optical axis and beacon."""
        dx = world_pos.x - self.config.position.x
        dy = world_pos.y - self.config.position.y
        dz = world_pos.z - self.config.position.z
        dist = math.sqrt(dx * dx + dy * dy + dz * dz)
        if dist < 1e-9:
            return None
        direction = (dx / dist, dy / dist, dz / dist)
        if _boresight is not None:
            return _boresight(self.optical_forward(), direction)
        fwd = self.optical_forward()
        dot = max(-1.0, min(1.0, sum(a * b for a, b in zip(fwd, direction))))
        return math.degrees(math.acos(dot))

    def state_dict(self, timestamp: float) -> dict:
        fwd = self.optical_forward()
        return {
            'pan': round(self._pan, 4),
            'tilt': round(self._tilt, 4),
            'pan_rate': round(self._pan_rate, 4),
            'tilt_rate': round(self._tilt_rate, 4),
            'fov_h': self.config.fov_h,
            'fov_v': self.config.fov_v,
            'optical_forward': {'x': round(fwd[0], 5), 'y': round(fwd[1], 5), 'z': round(fwd[2], 5)},
            'optical_forward_len': round(math.sqrt(sum(c * c for c in fwd)), 5),
            'platform_motion': getattr(self.config, 'platform_motion', 'stationary'),
            'position': self.config.position.as_dict(),
            'timestamp': timestamp,
        }
