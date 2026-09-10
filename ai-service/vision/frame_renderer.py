"""
FSOC PAT — Synthetic Camera-Frame Renderer (numpy)

Renders the 640x480 image the virtual FSOC camera would see:
  dark background + sparse stars + beacon spot + sensor noise.

Disturbances act ONLY on this rendered observation — never on the
ground-truth target state:
  - sensor noise  -> per-pixel image noise (gaussian / salt&pepper / poisson)
  - turbulence    -> beacon spot wander + dimming (scintillation)
  - camera jitter / vibration -> applied to camera pointing (engine), which
    moves the projected spot; the renderer just draws what it is given.
"""
import math
import numpy as np
from typing import Literal, Optional

NoiseType = Literal['gaussian', 'salt_pepper', 'poisson']


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
        rng: Optional[np.random.Generator] = None,
    ) -> np.ndarray:
        """Render one frame. Returns float32 HxW array in 0..1."""
        img = self._base.copy()
        r = rng if rng is not None else np.random

        if visible and px is not None and py is not None:
            half = max(size_px, 2.0) / 2.0
            if -half <= px <= self.w + half and -half <= py <= self.h + half:
                # Atmospheric scintillation: spot wander + dimming
                ox, oy, inten = 0.0, 0.0, intensity
                if turb_strength > 0:
                    ox = float(r.gauss(0, turb_strength * 2.5))
                    oy = float(r.gauss(0, turb_strength * 2.5))
                    inten = intensity * max(0.35, 1.0 - 0.35 * turb_strength * abs(float(r.gauss(0, 1))))
                self._draw_spot(img, px + ox, py + oy, size_px, inten, shape)

        # ── Sensor noise (observation only) ──────────────────
        if noise_level > 0:
            if noise_type == 'salt_pepper':
                frac = min(noise_level * 0.02, 0.05)
                n = int(img.size * frac)
                ys = r.integers(0, self.h, n)
                xs = r.integers(0, self.w, n)
                salt = r.random(n) < 0.5
                img[ys[salt], xs[salt]] = 1.0
                img[ys[~salt], xs[~salt]] = 0.0
            elif noise_type == 'poisson':
                photons = 60.0
                img = r.poisson(np.clip(img, 0, 1) * photons).astype(np.float32) / photons
                img += r.normal(0, noise_level * 0.03, img.shape).astype(np.float32)
            else:  # gaussian
                img = img + r.normal(0, noise_level * 0.25, img.shape).astype(np.float32)

        np.clip(img, 0.0, 1.0, out=img)
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
