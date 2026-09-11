"""
FSOC PAT — Detector Abstraction Layer

Architecture:
    DetectorInterface (ABC)
          ↓
    ┌──────────────────┐
    │                  │
  YOLODetector   ImageBeaconDetector
    │                  │
    └────────┬─────────┘
             ↓
       DetectionResult

ImageBeaconDetector is the default: it operates ONLY on the rendered
camera frame (threshold + weighted centroid). It never sees the
ground-truth target position — the true projection is used solely for
scoring (centroiding_error telemetry), never as the measurement.

YOLODetector keeps the same interface: drop in a trained model and the
rest of the pipeline is unchanged.
"""
import math
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional

import numpy as np


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
    detector: str   # 'image' | 'yolo'

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
    """All detectors consume a camera frame and return a centroid."""

    @abstractmethod
    def detect_frame(self, frame: np.ndarray) -> Optional[DetectionResult]:
        """
        Detect the beacon in a HxW float32 image (0..1).
        Returns DetectionResult or None when nothing is found.
        Must not use any ground-truth position information.
        """


class ImageBeaconDetector(DetectorInterface):
    """
    Robust brightest-cluster beacon detector:
      1. global argmax -> seed pixel (fast path; beacon is the brightest
         object under nominal conditions)
      2. local window around seed, threshold inside window; the seed must
         belong to a real cluster (>= MIN_PIXELS), otherwise it is an
         isolated outlier (e.g. salt noise) and the density fallback runs
      3. density fallback: seed at the densest thresholded neighbourhood
         via an integral image — isolated salt pixels can never win,
         while the true beacon cluster always does
      4. intensity-weighted centroid of the cluster
      5. confidence from peak strength + cluster size match
    """

    THRESHOLD = 0.40       # spot intensity floor (bg/stars stay < 0.2)
    MIN_PIXELS = 3         # smaller clusters are rejected as noise
    WINDOW = 26            # local analysis window, pixels

    def __init__(self, target_id: str = 'BEACON-01', expected_size_px: float = 10.0):
        self._target_id = target_id
        self._expected = max(expected_size_px, 2.0)

    def set_target(self, target_id: str, expected_size_px: float) -> None:
        self._target_id = target_id
        self._expected = max(expected_size_px, 2.0)

    def _cluster_at(self, frame: np.ndarray, sx: int, sy: int):
        """Validate the cluster around seed (sx, sy).

        Returns (count, peak, (x0, y0, mask)) or None when the seed does
        not belong to a real cluster.
        """
        h, w = frame.shape[:2]
        hw = self.WINDOW // 2
        x0, x1 = max(sx - hw, 0), min(sx + hw + 1, w)
        y0, y1 = max(sy - hw, 0), min(sy + hw + 1, h)
        window = frame[y0:y1, x0:x1]
        mask = window >= self.THRESHOLD * 0.75
        count = int(np.count_nonzero(mask))
        if count < self.MIN_PIXELS:
            return None
        return count, float(np.max(window)), (x0, y0, mask)

    def _dense_seed(self, frame: np.ndarray):
        """Seed at the densest thresholded neighbourhood (integral image).

        Returns (sx, sy, count) or None when no neighbourhood reaches
        MIN_PIXELS. Isolated impulsive pixels (salt) can never outvote a
        real beacon cluster here.
        """
        h, w = frame.shape[:2]
        hw = self.WINDOW // 2
        binary = (frame >= self.THRESHOLD * 0.75).astype(np.float32)
        # Integral image with zero padding for O(1) box sums
        integ = np.zeros((h + 1, w + 1), dtype=np.float32)
        integ[1:, 1:] = np.cumsum(np.cumsum(binary, axis=0), axis=1)
        # Box sum over a WINDOW-sized neighbourhood centred on each pixel.
        # y1/x1 are exclusive ends (<= h/w); integ's +1 padding absorbs them.
        y0 = np.maximum(np.arange(h) - hw, 0)
        y1 = np.minimum(np.arange(h) + hw + 1, h)
        x0 = np.maximum(np.arange(w) - hw, 0)
        x1 = np.minimum(np.arange(w) + hw + 1, w)
        rows = integ[y1][:, x1] - integ[y0][:, x1] \
             - integ[y1][:, x0] + integ[y0][:, x0]
        flat_idx = int(np.argmax(rows))
        best = float(rows.flat[flat_idx])
        if best < self.MIN_PIXELS:
            return None
        sy, sx = flat_idx // w, flat_idx % w
        return sx, sy, best

    def detect_frame(self, frame: np.ndarray) -> Optional[DetectionResult]:
        t0 = time.perf_counter()
        h, w = frame.shape[:2]

        # 1. fast path: brightest pixel seeds the search
        flat_idx = int(np.argmax(frame))
        sy, sx = flat_idx // w, flat_idx % w
        peak = float(frame[sy, sx])
        if peak < self.THRESHOLD:
            return None
        hit = self._cluster_at(frame, sx, sy)

        # 2. robust path: brightest pixel was an isolated outlier
        #    (salt noise) — re-seed at the densest neighbourhood.
        if hit is None:
            seed = self._dense_seed(frame)
            if seed is None:
                return None
            sx, sy, _ = seed
            hit = self._cluster_at(frame, sx, sy)
            if hit is None:
                return None
        _, peak, (x0, y0, mask) = hit

        # 3. intensity-weighted centroid inside the window
        y1 = y0 + mask.shape[0]
        x1 = x0 + mask.shape[1]
        yy, xx = np.mgrid[y0:y1, x0:x1]
        window = frame[y0:y1, x0:x1]
        weights = window * mask
        wsum = float(np.sum(weights))
        if wsum <= 0:
            return None
        cx = float(np.sum(xx * weights) / wsum)
        cy = float(np.sum(yy * weights) / wsum)

        # cluster extent -> bounding box
        ys, xs = np.nonzero(mask)
        bx0, bx1 = x0 + int(xs.min()), x0 + int(xs.max()) + 1
        by0, by1 = y0 + int(ys.min()), y0 + int(ys.max()) + 1

        # 4. confidence from peak + size agreement with expected spot
        area = (bx1 - bx0) * (by1 - by0)
        expected_area = self._expected * self._expected
        size_match = min(area, expected_area) / max(area, expected_area)
        confidence = max(0.0, min(1.0, 0.35 + 0.45 * peak + 0.20 * size_match))

        inference_ms = (time.perf_counter() - t0) * 1000.0
        return DetectionResult(
            target_id=self._target_id,
            cls='optical_beacon',
            confidence=confidence,
            bbox_x=float(bx0),
            bbox_y=float(by0),
            bbox_w=float(bx1 - bx0),
            bbox_h=float(by1 - by0),
            centroid_x=cx,
            centroid_y=cy,
            timestamp=time.time(),
            inference_ms=inference_ms,
            detector='image',
        )


class YOLODetector(DetectorInterface):
    """
    Plug-in point for a trained YOLO beacon model.

    To activate:
      1. pip install ultralytics
      2. provide a trained model path (e.g. best.pt)
      3. start the engine with use_yolo=True + model path

    Falls back to ImageBeaconDetector when the model is unavailable.
    """

    def __init__(self, model_path: str = 'models/beacon_yolo.pt'):
        self._available = False
        self._fallback = ImageBeaconDetector()
        try:
            from ultralytics import YOLO
            self._model = YOLO(model_path)
            self._available = True
        except Exception as e:
            print(f'[YOLODetector] Model unavailable: {e}. Falling back to image detector.')

    def detect_frame(self, frame: np.ndarray) -> Optional[DetectionResult]:
        # The simulation must NEVER crash because of the detector. YOLO
        # inference is not wired to a trained model, so every failure path
        # — missing model, inference error, unimplemented parser — falls
        # back to the classical image detector and says so in telemetry.
        try:
            if not self._available:
                raise RuntimeError('YOLO unavailable → Classical CV fallback')
            # Real YOLO inference on the virtual-camera frame goes here:
            #   results = self._model((frame * 255).astype(np.uint8))
            #   ... parse boxes, take highest-confidence 'beacon' class ...
            raise NotImplementedError('YOLO box parser not yet wired')
        except Exception as e:
            if getattr(self, '_warned', False) is False:
                print(f'[YOLODetector] {e}. Using classical CV fallback.')
                self._warned = True
            res = self._fallback.detect_frame(frame)
            if res is not None:
                res.detector = 'image (yolo-fallback)'
            return res


def create_detector(use_yolo: bool = False, model_path: str = '') -> DetectorInterface:
    """Factory — image-based detector by default, YOLO when available."""
    if use_yolo:
        d = YOLODetector(model_path or 'models/beacon_yolo.pt')
        if getattr(d, '_available', False):
            return d
        return d._fallback
    return ImageBeaconDetector()
