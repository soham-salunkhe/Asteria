"""
FSOC PAT — Synthetic Camera-Frame Renderer (numpy)

Renders the 640x480 image the virtual FSOC camera would see:
  dark background + sparse stars + beacon spot + sensor noise.

Disturbances act ONLY on this rendered observation — never on the
ground-truth target state:
  - sensor noise       → per-pixel image noise (gaussian / salt&pepper / poisson)
  - turbulence         → beacon spot wander + dimming (scintillation)
  - atmospheric mode   → contrast/brightness degradation of the detection image
                         (clear / haze / fog / rain / low_light)
  - camera jitter / vibration → applied to camera pointing (engine), which
                                moves the projected spot; the renderer just
                                draws what it is given.

PS169 §21 disturbance parameters:
  - noise_level maps linearly: noise_level=1.0 → 20 px std-dev (Gaussian)
    pixel_std = noise_level * PS169_MAX_NOISE_STD_PX
    normalised_std = pixel_std / 255   (image is 0..1 float32)

  - atmospheric modes (haze/fog/rain/low_light) reduce contrast and/or
    brightness in the float32 detection image so the actual ImageBeaconDetector
    performance degrades — not merely the frontend canvas overlay.
"""
import math
import numpy as np
from typing import Literal, Optional

NoiseType = Literal['gaussian', 'salt_pepper', 'poisson']
AtmosMode = Literal['clear', 'haze', 'fog', 'rain', 'low_light']

# ── PS169 noise calibration ───────────────────────────────────────
# PS169 Table row 2: Max Std Deviation of Noise = 20 pixels.
# The image is normalised 0..1 float32 (8-bit equivalent = pixel_value/255).
# noise_level ∈ [0, 1] where 1.0 → exactly 20 px std-dev on an 8-bit scale.
# Therefore: sigma_normalised = noise_level * 20 / 255
PS169_MAX_NOISE_STD_PX: float = 20.0    # pixels


def _noise_sigma(noise_level: float) -> float:
    """Convert noise_level (0–1) → normalised std-dev for a 0..1 float image.

    noise_level=0   →  0.0  (no noise)
    noise_level=1   →  20 / 255 ≈ 0.0784  (PS169 maximum 20 px std-dev)
    """
    return float(noise_level) * PS169_MAX_NOISE_STD_PX / 255.0


class FrameRenderer:
    """Renders synthetic FSOC camera frames as float32 0..1 arrays."""

    def __init__(self, width: int = 640, height: int = 480, seed: int = 7):
        self.w = width
        self.h = height
        rng = np.random.default_rng(seed)
        # Fixed sparse star field baked into the background
        self._stars = np.zeros((height, width), dtype=np.float32)
        n_stars = 46
        xs = rng.integers(0, width, n_stars)
        ys = rng.integers(0, height, n_stars)
        vals = rng.uniform(0.05, 0.16, n_stars).astype(np.float32)
        self._stars[ys, xs] = vals
        self._base = np.full((height, width), 0.028, dtype=np.float32) + self._stars

    # ── Public API ────────────────────────────────────────────

    def render(
        self,
        px: Optional[float],
        py: Optional[float],
        *,
        visible: bool,
        size_px: float = 10.0,
        intensity: float = 0.95,
        shape: str = 'square',
        noise_type: NoiseType = 'gaussian',
        noise_level: float = 0.0,
        turb_strength: float = 0.0,
        atmos_mode: AtmosMode = 'clear',
        atmos_strength: float = 0.0,
        rng: Optional[np.random.Generator] = None,
    ) -> np.ndarray:
        """Render one frame. Returns float32 HxW array in 0..1.

        Parameters
        ----------
        noise_level : float
            PS169-calibrated noise level in [0, 1].
            noise_level=1.0 → Gaussian std-dev = 20 px (PS169 maximum).
        atmos_mode : str
            Atmospheric degradation mode applied to the detection image:
            'clear'     – no degradation
            'haze'      – contrast reduction + mild brightness reduction
            'fog'       – strong contrast + brightness reduction + spatial blur
            'rain'      – random bright streaks + contrast reduction
            'low_light' – strong brightness reduction + contrast reduction
        atmos_strength : float
            Strength of atmospheric effect in [0, 1].  0 = no effect.
        """
        img = self._base.copy()
        r = rng if rng is not None else np.random

        if visible and px is not None and py is not None:
            half = max(size_px, 2.0) / 2.0
            if -half <= px <= self.w + half and -half <= py <= self.h + half:
                # Atmospheric scintillation: spot wander + dimming
                ox, oy, inten = 0.0, 0.0, intensity
                if turb_strength > 0:
                    ox = float(r.normal(0, turb_strength * 2.5))
                    oy = float(r.normal(0, turb_strength * 2.5))
                    inten = intensity * max(0.35, 1.0 - 0.35 * turb_strength * abs(float(r.normal(0, 1))))
                self._draw_spot(img, px + ox, py + oy, size_px, inten, shape)

        # ── Atmospheric degradation (affects the detection image) ────────
        # Applied AFTER drawing the beacon so the beacon itself is also
        # subject to the same atmospheric path losses — physically correct.
        if atmos_mode != 'clear' and atmos_strength > 0:
            img = self._apply_atmospheric(img, atmos_mode, atmos_strength, r)

        # ── Sensor noise (observation only) ──────────────────────────────
        # PS169-calibrated: noise_level=1 → 20 px std-dev on 8-bit scale
        if noise_level > 0:
            sigma = _noise_sigma(noise_level)
            if noise_type == 'salt_pepper':
                # PS169 §21 row 1: "around 10% of image"
                # noise_level=1 → 10% of pixels are salt or pepper
                frac = min(noise_level * 0.10, 0.10)
                n = int(img.size * frac)
                if n > 0:
                    ys = r.integers(0, self.h, n)
                    xs = r.integers(0, self.w, n)
                    salt = r.random(n) < 0.5
                    img[ys[salt], xs[salt]] = 1.0
                    img[ys[~salt], xs[~salt]] = 0.0
            elif noise_type == 'poisson':
                # Poisson photon-count model; residual read-noise at sigma level
                photons = max(1.0, 1.0 / (sigma + 1e-9))   # fewer photons = more noise
                photons = min(photons, 200.0)
                img = r.poisson(np.clip(img, 0, 1) * photons).astype(np.float32) / photons
                img += r.normal(0, sigma * 0.3, img.shape).astype(np.float32)
            else:  # gaussian — PS169-calibrated
                img = img + r.normal(0, sigma, img.shape).astype(np.float32)

        np.clip(img, 0.0, 1.0, out=img)
        return img

    # ── Atmospheric degradation ────────────────────────────────

    def _apply_atmospheric(
        self,
        img: np.ndarray,
        mode: AtmosMode,
        strength: float,
        r: np.random.Generator,
    ) -> np.ndarray:
        """Apply atmospheric degradation to the float32 detection image.

        All modes reduce contrast and/or brightness so that the actual
        ImageBeaconDetector performance degrades in proportion to strength,
        not just the frontend canvas overlay.

        Physics modelled (simplified):
          haze      – uniform path extinction, partial contrast reduction
          fog       – strong uniform scatter, heavy contrast + brightness drop
          rain       – streaks as bright noise + moderate contrast reduction
          low_light  – severe brightness reduction (≈ night / eclipse)
        """
        s = float(np.clip(strength, 0.0, 1.0))

        if mode == 'haze':
            # Haze: additive fog term + contrast reduction.
            # At strength=1: contrast → 30% of original, fog veil = 0.25.
            contrast = 1.0 - 0.70 * s         # range [0.30, 1.00]
            veil = 0.25 * s                    # additive whitening
            img = img * contrast + veil

        elif mode == 'fog':
            # Fog: severe contrast + brightness collapse.
            # At strength=1: contrast → 15%, veil = 0.50.
            contrast = 1.0 - 0.85 * s         # range [0.15, 1.00]
            veil = 0.50 * s                    # heavy whitening
            img = img * contrast + veil
            # Optional spatial blur (box approximation using np.convolve)
            # Avoids scipy dependency — simple row+column averaging.
            if s > 0.3:
                k = max(1, int(s * 5))         # kernel half-width 1–5
                kernel = np.ones(2 * k + 1, dtype=np.float32) / (2 * k + 1)
                for row in range(img.shape[0]):
                    img[row, :] = np.convolve(img[row, :], kernel, mode='same')
                for col in range(img.shape[1]):
                    img[:, col] = np.convolve(img[:, col], kernel, mode='same')

        elif mode == 'rain':
            # Rain: random bright streaks + mild contrast reduction.
            # The streaks appear in the detection image as false-bright pixels.
            contrast = 1.0 - 0.30 * s
            img = img * contrast
            # Random diagonal streaks (column-runs)
            n_streaks = int(s * 40)
            if n_streaks > 0:
                xs = r.integers(0, self.w, n_streaks)
                ys = r.integers(0, self.h - 10, n_streaks)
                lengths = r.integers(5, 14, n_streaks)
                brightness = r.uniform(0.25, 0.55, n_streaks).astype(np.float32)
                for i in range(n_streaks):
                    y0 = int(ys[i])
                    y1 = min(int(ys[i]) + int(lengths[i]), self.h)
                    x = int(xs[i])
                    img[y0:y1, x] = np.maximum(img[y0:y1, x], brightness[i])

        elif mode == 'low_light':
            # Low-light: strong brightness reduction + moderate contrast loss.
            # At strength=1: brightness → 10% of original.
            brightness_factor = 1.0 - 0.90 * s   # range [0.10, 1.00]
            contrast = 1.0 - 0.40 * s
            img = img * contrast * brightness_factor

        return img

    # ── Spot drawing ──────────────────────────────────────────

    def _draw_spot(self, img: np.ndarray, cx: float, cy: float,
                   size_px: float, intensity: float, shape: str) -> None:
        half = max(size_px, 2.0) / 2.0
        x0 = max(int(math.floor(cx - half - 2)), 0)
        x1 = min(int(math.ceil(cx + half + 2)) + 1, self.w)
        y0 = max(int(math.floor(cy - half - 2)), 0)
        y1 = min(int(math.ceil(cy + half + 2)) + 1, self.h)
        if x0 >= x1 or y0 >= y1:
            return
        yy, xx = np.mgrid[y0:y1, x0:x1]
        if shape == 'circle':
            rad = half
            core = (xx - cx) ** 2 + (yy - cy) ** 2 <= rad * rad
            halo = ((xx - cx) ** 2 + (yy - cy) ** 2 <= (rad + 2) ** 2) & ~core
        else:  # square beacon (default)
            core = (np.abs(xx - cx) <= half) & (np.abs(yy - cy) <= half)
            halo = (np.abs(xx - cx) <= half + 2) & (np.abs(yy - cy) <= half + 2) & ~core
        patch = img[y0:y1, x0:x1]
        patch[core] = np.maximum(patch[core], np.float32(intensity))
        patch[halo] = np.maximum(patch[halo], np.float32(0.30 * intensity))
