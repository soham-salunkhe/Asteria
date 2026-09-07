"""
FSOC PAT — Disturbance Engine
Applies atmospheric turbulence, platform vibration, camera motion,
sensor noise, and target motion variation to the simulation state.
"""
import math
import random
import time
from dataclasses import dataclass, field


@dataclass
class AtmosphericTurbulence:
    enabled: bool = False
    strength: float = 0.3      # 0-1
    frequency: float = 2.0     # Hz


@dataclass
class PlatformVibration:
    enabled: bool = False
    amplitude: float = 0.5     # degrees peak-to-peak
    frequency: float = 10.0    # Hz


@dataclass
class CameraMotion:
    enabled: bool = False
    angular_disturbance: float = 0.1   # deg std-dev per frame


@dataclass
class SensorNoise:
    enabled: bool = False
    noise_level: float = 0.05   # 0-1


@dataclass
class TargetMotionVariation:
    enabled: bool = False
    velocity_variation: float = 0.3   # fraction of base velocity


@dataclass
class DisturbanceConfig:
    atmospheric_turbulence: AtmosphericTurbulence = field(
        default_factory=AtmosphericTurbulence)
    platform_vibration: PlatformVibration = field(
        default_factory=PlatformVibration)
    camera_motion: CameraMotion = field(
        default_factory=CameraMotion)
    sensor_noise: SensorNoise = field(
        default_factory=SensorNoise)
    target_motion_variation: TargetMotionVariation = field(
        default_factory=TargetMotionVariation)


class DisturbanceEngine:
    """
    Computes perturbation vectors (Δpan, Δtilt) and noise scalars
    for each simulation frame. All disturbances are physically motivated.
    """

    def __init__(self, config: DisturbanceConfig | None = None):
        self.config = config or DisturbanceConfig()
        self._phase_turb: float = random.uniform(0, 2 * math.pi)
        self._phase_vib: float = random.uniform(0, 2 * math.pi)
        self._t = 0.0

    def update(self, dt: float) -> dict:
        """
        Compute disturbances for this frame.
        Returns a dict with angular perturbations and metadata.
        """
        self._t += dt
        t = self._t

        dpan = 0.0
        dtilt = 0.0
        noise_scale = 0.0

        cfg = self.config

        # ── Atmospheric turbulence ─────────────────────────
        if cfg.atmospheric_turbulence.enabled:
            s = cfg.atmospheric_turbulence.strength
            f = cfg.atmospheric_turbulence.frequency
            # Band-limited Gaussian-envelope turbulence
            dpan += s * 0.8 * (
                math.sin(2 * math.pi * f * t + self._phase_turb) * 0.6
                + random.gauss(0, 0.4)
            )
            dtilt += s * 0.5 * (
                math.cos(2 * math.pi * f * 0.7 * t + self._phase_turb + 1.0) * 0.6
                + random.gauss(0, 0.3)
            )

        # ── Platform vibration ─────────────────────────────
        if cfg.platform_vibration.enabled:
            a = cfg.platform_vibration.amplitude / 2.0   # half amplitude
            f = cfg.platform_vibration.frequency
            dpan += a * math.sin(2 * math.pi * f * t + self._phase_vib)
            dtilt += a * 0.6 * math.sin(
                2 * math.pi * f * 1.3 * t + self._phase_vib + 0.8)

        # ── Camera motion disturbance ──────────────────────
        if cfg.camera_motion.enabled:
            sigma = cfg.camera_motion.angular_disturbance
            dpan += random.gauss(0, sigma)
            dtilt += random.gauss(0, sigma * 0.7)

        # ── Sensor noise ───────────────────────────────────
        if cfg.sensor_noise.enabled:
            noise_scale = cfg.sensor_noise.noise_level

        # ── Target motion variation ────────────────────────
        vel_var = 0.0
        if cfg.target_motion_variation.enabled:
            vel_var = cfg.target_motion_variation.velocity_variation

        # Total disturbance index (0-1)
        total_index = min(1.0, (
            (cfg.atmospheric_turbulence.strength
             if cfg.atmospheric_turbulence.enabled else 0.0) * 0.3
            + (min(cfg.platform_vibration.amplitude / 5.0, 1.0)
               if cfg.platform_vibration.enabled else 0.0) * 0.3
            + (cfg.camera_motion.angular_disturbance / 2.0
               if cfg.camera_motion.enabled else 0.0) * 0.2
            + (cfg.sensor_noise.noise_level
               if cfg.sensor_noise.enabled else 0.0) * 0.1
            + (cfg.target_motion_variation.velocity_variation
               if cfg.target_motion_variation.enabled else 0.0) * 0.1
        ))

        active_count = sum([
            cfg.atmospheric_turbulence.enabled,
            cfg.platform_vibration.enabled,
            cfg.camera_motion.enabled,
            cfg.sensor_noise.enabled,
            cfg.target_motion_variation.enabled,
        ])

        return {
            'dpan': dpan,
            'dtilt': dtilt,
            'noise_scale': noise_scale,
            'velocity_variation': vel_var,
            'total_disturbance_index': round(total_index, 4),
            'active_count': active_count,
            'current_perturbation': {'x': round(dpan, 4), 'y': round(dtilt, 4)},
            'config': self._config_dict(),
        }

    def update_config(self, config: DisturbanceConfig) -> None:
        self.config = config

    def _config_dict(self) -> dict:
        c = self.config
        return {
            'atmospheric_turbulence': {
                'enabled': c.atmospheric_turbulence.enabled,
                'strength': c.atmospheric_turbulence.strength,
                'frequency': c.atmospheric_turbulence.frequency,
            },
            'platform_vibration': {
                'enabled': c.platform_vibration.enabled,
                'amplitude': c.platform_vibration.amplitude,
                'frequency': c.platform_vibration.frequency,
            },
            'camera_motion': {
                'enabled': c.camera_motion.enabled,
                'angular_disturbance': c.camera_motion.angular_disturbance,
            },
            'sensor_noise': {
                'enabled': c.sensor_noise.enabled,
                'noise_level': c.sensor_noise.noise_level,
            },
            'target_motion_variation': {
                'enabled': c.target_motion_variation.enabled,
                'velocity_variation': c.target_motion_variation.velocity_variation,
            },
        }

    def reset(self) -> None:
        self._t = 0.0
        self._phase_turb = random.uniform(0, 2 * math.pi)
        self._phase_vib = random.uniform(0, 2 * math.pi)
