"""
FSOC PAT — Simulation Environment
Defines world parameters for each scenario type.
"""
from dataclasses import dataclass, field
from typing import Literal

EnvironmentType = Literal['open_sky', 'urban', 'mountain', 'uav', 'satellite']


@dataclass
class EnvironmentConfig:
    type: EnvironmentType = 'urban'
    # World bounds in metres (±half-extent from origin)
    world_half_extent: float = 500.0
    # Nominal background noise added to imagery
    background_noise: float = 0.02
    # Scintillation index (Cn² proxy) — higher = stronger turbulence potential
    scintillation_index: float = 1e-14
    # Nominal wind speed m/s (influences turbulence frequency)
    wind_speed: float = 5.0
    # Description string for reports
    description: str = ''


# Pre-built scenario environment presets
ENVIRONMENT_PRESETS: dict[str, EnvironmentConfig] = {
    'open_sky': EnvironmentConfig(
        type='open_sky',
        background_noise=0.01,
        scintillation_index=5e-15,
        wind_speed=3.0,
        description='Clear open-sky scenario with minimal atmospheric effects'
    ),
    'urban': EnvironmentConfig(
        type='urban',
        background_noise=0.05,
        scintillation_index=2e-14,
        wind_speed=6.0,
        description='Urban environment with moderate thermal turbulence'
    ),
    'mountain': EnvironmentConfig(
        type='mountain',
        background_noise=0.03,
        scintillation_index=3e-14,
        wind_speed=12.0,
        description='High-altitude mountain scenario with strong wind shear'
    ),
    'uav': EnvironmentConfig(
        type='uav',
        background_noise=0.04,
        scintillation_index=1e-14,
        wind_speed=8.0,
        description='UAV-to-ground link with platform vibration'
    ),
    'satellite': EnvironmentConfig(
        type='satellite',
        background_noise=0.02,
        scintillation_index=8e-15,
        wind_speed=0.0,
        description='Satellite downlink scenario — upper-atmosphere turbulence only'
    ),
}


def get_environment(env_type: EnvironmentType) -> EnvironmentConfig:
    return ENVIRONMENT_PRESETS.get(env_type, ENVIRONMENT_PRESETS['urban'])
