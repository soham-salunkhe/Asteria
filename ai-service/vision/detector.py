"""
FSOC PAT — Detector Abstraction Layer

Architecture:
    DetectorInterface (ABC)
          ↓
    ┌─────────────────┐
    │                 │
  YOLODetector    MockDetector
    │                 │
    └────────┬────────┘
             ↓
       DetectionResult

The MockDetector provides deterministic, physics-aware detection using the
known target position. It simulates confidence variation, occasional misses,
and bounding-box noise to give the full pipeline a realistic workout.

When a real YOLO model is available, drop in YOLODetector and the rest of
the pipeline is unchanged.
"""
import math
import random
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional, Tuple


@dataclass
class DetectionResult:
    target_id: str
    cls: str
    confidence: float
    bbox_x: float
    bbox_y: float
    bbox_w: float
    bbox_h: float
    centroid_x: float
    centroid_y: float
    timestamp: float
    inference_ms: float
    detector: str   # 'yolo' | 'mock'

    def to_dict(self) -> dict:
        return {
            'target_id': self.target_id,
            'class': self.cls,
            'confidence': round(self.confidence, 4),
            'bounding_box': {
                'x': round(self.bbox_x, 1),
                'y': round(self.bbox_y, 1),
                'width': round(self.bbox_w, 1),
                'height': round(self.bbox_h, 1),
            },
            'centroid': {
                'x': round(self.centroid_x, 2),
                'y': round(self.centroid_y, 2),
            },
            'timestamp': self.timestamp,
            'inference_ms': round(self.inference_ms, 2),
            'detector': self.detector,
        }


class DetectorInterface(ABC):
    """Abstract base class — all detectors must implement detect()."""

    @abstractmethod
    def detect(
        self,
        pixel_x: float,
        pixel_y: float,
        image_w: int,
        image_h: int,
        noise_scale: float = 0.0,
        target_visible: bool = True,
    ) -> Optional[DetectionResult]:
        """
        Attempt to detect the beacon.

        Args:
            pixel_x, pixel_y  : True pixel position (from camera projection)
            image_w, image_h  : Frame resolution
            noise_scale       : Added measurement noise (0-1)
            target_visible    : Whether the target is actually in frame

        Returns:
            DetectionResult or None if not detected
        """


class MockDetector(DetectorInterface):
    """
    Deterministic mock detector for when a real YOLO model is unavailable.

    Behaviour:
      - Uses known pixel position ± Gaussian noise
      - Confidence follows a sigmoid of angular proximity to frame centre
      - Random misses at rate proportional to noise_scale
      - Sub-pixel accuracy degrades gracefully with noise
    """

    NOMINAL_CONFIDENCE = 0.94
    MISS_RATE_BASE = 0.02        # base miss probability per frame
    BBOX_SIZE = 24               # nominal bounding box half-size, pixels
    NOISE_PX_SIGMA = 3.0         # pixels of Gaussian centroid noise

    def detect(
        self,
        pixel_x: float,
        pixel_y: float,
        image_w: int,
        image_h: int,
        noise_scale: float = 0.0,
        target_visible: bool = True,
    ) -> Optional[DetectionResult]:
        t0 = time.perf_counter()

        if not target_visible:
            return None

        # Random miss based on noise
        miss_prob = self.MISS_RATE_BASE + noise_scale * 0.25
        if random.random() < miss_prob:
            return None

        # Add measurement noise
        sigma = self.NOISE_PX_SIGMA * (1 + noise_scale * 5.0)
        cx = pixel_x + random.gauss(0, sigma)
        cy = pixel_y + random.gauss(0, sigma)

        # Confidence — higher near frame centre, degrades near edges
        norm_x = abs(cx - image_w / 2) / (image_w / 2)
        norm_y = abs(cy - image_h / 2) / (image_h / 2)
        proximity = 1.0 - 0.5 * (norm_x + norm_y)
        confidence = self.NOMINAL_CONFIDENCE * proximity
        confidence *= (1.0 - noise_scale * 0.3)
        confidence += random.gauss(0, 0.015)
        confidence = max(0.0, min(1.0, confidence))

        # Bounding box around centroid
        half = self.BBOX_SIZE * (1 + noise_scale * 0.5)
        bbox_x = cx - half
        bbox_y = cy - half
        bbox_w = half * 2
        bbox_h = half * 2

        t1 = time.perf_counter()
        inference_ms = (t1 - t0) * 1000.0 + random.uniform(2.0, 8.0)

        return DetectionResult(
            target_id='BEACON-01',
            cls='optical_beacon',
            confidence=confidence,
            bbox_x=bbox_x,
            bbox_y=bbox_y,
            bbox_w=bbox_w,
            bbox_h=bbox_h,
            centroid_x=cx,
            centroid_y=cy,
            timestamp=time.time(),
            inference_ms=inference_ms,
            detector='mock',
        )


class YOLODetector(DetectorInterface):
    """
    Placeholder for real YOLO model integration.

    To activate:
      1. Install ultralytics: pip install ultralytics
      2. Provide a trained model path (e.g. best.pt)
      3. Replace MockDetector with YOLODetector in engine.py

    The detect() signature is identical to MockDetector — no other
    pipeline changes are required.
    """

    def __init__(self, model_path: str = 'models/beacon_yolo.pt'):
        self._available = False
        try:
            from ultralytics import YOLO
            self._model = YOLO(model_path)
            self._available = True
        except Exception as e:
            print(f'[YOLODetector] Model unavailable: {e}. Falling back to MockDetector.')
            self._fallback = MockDetector()

    def detect(
        self,
        pixel_x: float,
        pixel_y: float,
        image_w: int,
        image_h: int,
        noise_scale: float = 0.0,
        target_visible: bool = True,
    ) -> Optional[DetectionResult]:
        if not self._available:
            return self._fallback.detect(
                pixel_x, pixel_y, image_w, image_h, noise_scale, target_visible)

        # Real YOLO inference would go here — generate a frame from the
        # virtual camera, pass it to self._model(), parse results.
        # This skeleton is ready to be completed with real inference code.
        raise NotImplementedError(
            'Real YOLO inference not yet implemented. '
            'Connect camera frame generation here.')


def create_detector(use_yolo: bool = False, model_path: str = '') -> DetectorInterface:
    """Factory — returns the appropriate detector."""
    if use_yolo:
        d = YOLODetector(model_path)
        if getattr(d, '_available', False):
            return d
    return MockDetector()
