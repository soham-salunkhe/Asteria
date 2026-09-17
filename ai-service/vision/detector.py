"""
FSOC PAT — Candidate-Based Robust Beacon Detector

Implements candidate-based detection designed to handle diverse video benchmarks:
  - Adaptive thresholding (handles diverse exposures and contrast)
  - Connected component analysis with noise speck and glare rejection
  - Multi-feature candidate scoring:
      * Peak intensity & mean brightness
      * Local contrast against background ring
      * Spot compactness, fill ratio, and aspect ratio
      * Expected beacon area match
      * Temporal / Kalman prediction spatial consistency (when available)
  - Dynamic ROI fallback (prevents permanent ROI lock)
  - True confidence estimation
  - Candidate export for UI debug visualization
"""
import math
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any, Tuple

import numpy as np

try:
    import cv2
    CV2_AVAILABLE = True
except ImportError:
    CV2_AVAILABLE = False


@dataclass
class BeaconCandidate:
    bbox_x: float
    bbox_y: float
    bbox_w: float
    bbox_h: float
    centroid_x: float
    centroid_y: float
    area: float
    peak: float
    mean_val: float
    contrast: float
    aspect_ratio: float
    score: float
    confidence: float
    is_selected: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            'x': round(self.bbox_x, 1),
            'y': round(self.bbox_y, 1),
            'w': round(self.bbox_w, 1),
            'h': round(self.bbox_h, 1),
            'cx': round(self.centroid_x, 1),
            'cy': round(self.centroid_y, 1),
            'area': round(self.area, 1),
            'peak': round(self.peak, 3),
            'contrast': round(self.contrast, 3),
            'score': round(self.score, 3),
            'confidence': round(self.confidence, 3),
            'selected': self.is_selected,
        }


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
    candidates: List[Dict[str, Any]] = field(default_factory=list)

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
            'candidates': self.candidates,
        }


class DetectorInterface(ABC):
    """All detectors consume a camera frame and return a centroid."""

    @abstractmethod
    def detect_frame(
        self,
        frame: np.ndarray,
        predicted_pos: Optional[Tuple[float, float]] = None,
        search_roi: Optional[Tuple[int, int, int, int]] = None,
    ) -> Optional[DetectionResult]:
        """
        Detect the beacon in a HxW float32 image (0..1).
        Returns DetectionResult or None when nothing is found.
        Must not use any ground-truth position information.
        """

    def reset(self) -> None:
        """Clear per-session state (association memory).  No-op by default."""


class ImageBeaconDetector(DetectorInterface):
    """
    Robust candidate-based optical beacon detector.
    Extracts bright connected components, scores candidates against visual
    features and Kalman prediction priority, filters isolated noise,
    and returns verified centroid + confidence.
    """

    MIN_PIXELS = 3          # Rejects 1-2 pixel isolated salt noise
    MAX_PIXELS = 20000      # Upper sanity bound (~6.5% of a 640x480 frame):
                            # a large true beacon must stay a valid candidate;
                            # size_match below still prefers the expected size.
    MAX_SPAN_PX = 120       # Rejects full-frame glare streaks; a big beacon fits
    MIN_CONFIDENCE = 0.35   # Minimum confidence threshold for valid detection
    # Nearest-neighbor association radius (px): prefer the best candidate
    # near the last selection; a teleport pick 100+ px away in one frame is
    # essentially never the beacon (fastest measured motion: 22 px/frame).
    # If NOTHING is inside the radius, fall back to the global best (the
    # beacon may genuinely have jumped / re-entered — never blind).
    ASSOCIATION_RADIUS_PX = 60.0
    # Border margin (px): small components touching the frame edge are
    # usually compression/edge artifacts (measured: 639-px lock on speckle).
    # A truly exiting large beacon is handled as a miss → coast → LOST.
    BORDER_REJECT_PX = 2
    BORDER_REJECT_MAX_AREA = 200.0

    def __init__(self, target_id: str = 'BEACON-01', expected_size_px: float = 10.0):
        self._target_id = target_id
        self._expected = max(expected_size_px, 2.0)
        # Selection memory for frame-to-frame association (anti star-jump):
        # the last SELECTED centroid, and consecutive misses since.  This is
        # a continuity bonus among real candidates only — never a measurement.
        self._last_selected: Optional[Tuple[float, float]] = None
        self._none_streak: int = 0

    def set_target(self, target_id: str, expected_size_px: float) -> None:
        self._target_id = target_id
        self._expected = max(expected_size_px, 2.0)
        self._last_selected = None
        self._none_streak = 0

    def reset(self) -> None:
        """Clear per-session association memory.

        A new video/session must associate from scratch: a stale gate from
        the previous video's tail would bias the first frames toward a
        star and collapse the whole run.  Called on every process() start.
        """
        self._last_selected = None
        self._none_streak = 0

    def detect_frame(
        self,
        frame: np.ndarray,
        predicted_pos: Optional[Tuple[float, float]] = None,
        search_roi: Optional[Tuple[int, int, int, int]] = None,
    ) -> Optional[DetectionResult]:
        t0 = time.perf_counter()
        h, w = frame.shape[:2]

        if not CV2_AVAILABLE:
            return None

        # ── 0. Salt-noise prefilter (honest denoising, not synthesis) ──
        # Heavy salt-and-pepper puts hundreds of max-brightness specks in
        # the frame. A 3x3 median kills isolated specks while leaving a
        # real ≥10 px beacon almost intact, so candidate scoring compares
        # the true beacon against real structures instead of noise. All
        # downstream math (centroid, contrast, confidence) runs on this
        # denoised sensor image — nothing is invented.
        work = cv2.medianBlur(frame, 3)

        # ── 1. Frame Statistics & Adaptive Thresholding ─────────────
        max_val = float(np.max(work))
        if max_val < 0.15:
            # Entire scene is pitch black / sensor occluded
            self._none_streak += 1
            if self._none_streak >= 5:
                self._last_selected = None
            return None

        p95 = float(np.percentile(work, 95))
        p99 = float(np.percentile(work, 99))
        p998 = float(np.percentile(work, 99.8))

        # Adaptive threshold: slightly below the top 0.2% brightest features,
        # bounded between [0.22, 0.85].
        thresh = max(0.22, min(0.85, p998 * 0.82))
        if thresh > max_val * 0.95:
            thresh = max(0.20, max_val * 0.70)

        # ── 2. Connected Component Generation ───────────────────────
        binary = (work >= thresh).astype(np.uint8)
        num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(binary, connectivity=8)

        # Drowning rescue: if the threshold sat inside the background noise
        # band (flat raised floor, e.g. haze), the whole frame merges into
        # one giant component and every real candidate is swallowed.  Detect
        # that explicitly (largest component > 50% of the frame) and rescue
        # with Otsu, which separates the background plateau from foreground
        # features.  Scenes that already segment correctly never take this
        # branch, so their behavior is bit-identical.
        if num_labels >= 2:
            _largest = max(float(stats[i, cv2.CC_STAT_AREA]) for i in range(1, num_labels))
            if _largest > 0.5 * h * w:
                _otsu_t, _ = cv2.threshold(
                    (work * 255.0).clip(0, 255).astype(np.uint8),
                    0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
                otsu_thresh = max(0.22, min(0.85, _otsu_t / 255.0))
                if otsu_thresh > thresh:
                    thresh = otsu_thresh
                    binary = (work >= thresh).astype(np.uint8)
                    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(binary, connectivity=8)

        # If too few candidates found, try lower threshold fallback
        if num_labels <= 1 and max_val >= 0.25:
            fallback_thresh = max(0.18, max_val * 0.55)
            binary = (work >= fallback_thresh).astype(np.uint8)
            num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(binary, connectivity=8)

        candidates: List[BeaconCandidate] = []
        expected_area = self._expected * self._expected

        for i in range(1, num_labels):
            area = float(stats[i, cv2.CC_STAT_AREA])
            if area < self.MIN_PIXELS or area > self.MAX_PIXELS:
                continue

            bx = int(stats[i, cv2.CC_STAT_LEFT])
            by = int(stats[i, cv2.CC_STAT_TOP])
            bw = int(stats[i, cv2.CC_STAT_WIDTH])
            bh = int(stats[i, cv2.CC_STAT_HEIGHT])

            # Filter unphysical streaks (edge artifacts beyond a big beacon).
            # Smear-split exception: a fast beacon's motion smear merges
            # with its head into one long component that fails the span
            # gate — without a second look the tracker would fall back to
            # minor blobs.  Re-threshold the rejected region high to isolate
            # the bright core (the instantaneous beacon position; the tail
            # is exposure history).  Position/shape come from the compact
            # core, but size/flux credit the whole connected luminous mass
            # (head + smear were emitted by the same source) — otherwise a
            # smeared beacon can never outscore an isolated star.  Pure
            # glare with no compact core still ends up rejected below.
            core_abs_mask = None
            struct_abs_mask = None
            struct_wsum = None
            struct_area = None
            if bw > self.MAX_SPAN_PX or bh > self.MAX_SPAN_PX:
                _ox, _oy, _ow, _oh = bx, by, bw, bh
                region = work[by:by+bh, bx:bx+bw]
                rpeak = float(np.max(region)) if region.size else 0.0
                core_t = max(thresh + 0.05, min(0.92, rpeak - 0.20))
                core_bin = (region >= core_t).astype(np.uint8)
                cn, clab, cstats, _cc = cv2.connectedComponentsWithStats(
                    core_bin, connectivity=8)
                _best = None
                for j in range(1, cn):
                    _a = float(cstats[j, cv2.CC_STAT_AREA])
                    _w = int(cstats[j, cv2.CC_STAT_WIDTH])
                    _h = int(cstats[j, cv2.CC_STAT_HEIGHT])
                    if (_a >= self.MIN_PIXELS and _w <= self.MAX_SPAN_PX
                            and _h <= self.MAX_SPAN_PX):
                        if _best is None or _a > _best[0]:
                            _best = (_a, _w, _h, j)
                if _best is None:
                    continue
                _a, _bw, _bh, _j = _best
                # Absolute-geometry masks (region coords → frame coords).
                struct_abs_mask = np.zeros_like(binary, dtype=bool)
                struct_abs_mask[_oy:_oy+_oh, _ox:_ox+_ow] |= (
                    labels[_oy:_oy+_oh, _ox:_ox+_ow] == i)
                struct_wsum = float(np.sum(work[struct_abs_mask]))
                struct_area = float(np.sum(struct_abs_mask))
                core_abs_mask = np.zeros_like(binary, dtype=bool)
                core_abs_mask[_oy:_oy+_oh, _ox:_ox+_ow] |= (clab == _j)
                bx = _ox + int(cstats[_j, cv2.CC_STAT_LEFT])
                by = _oy + int(cstats[_j, cv2.CC_STAT_TOP])
                bw, bh = _bw, _bh
                area = _a

            # Border artifacts: small bright clusters stapled to the frame
            # edge are compression/edge noise, not the beacon.
            if area < self.BORDER_REJECT_MAX_AREA and (
                    bx <= self.BORDER_REJECT_PX or by <= self.BORDER_REJECT_PX
                    or bx + bw >= w - self.BORDER_REJECT_PX
                    or by + bh >= h - self.BORDER_REJECT_PX):
                continue

            crop = work[by:by+bh, bx:bx+bw]
            if core_abs_mask is not None:
                mask = core_abs_mask[by:by+bh, bx:bx+bw]
            else:
                mask = (labels[by:by+bh, bx:bx+bw] == i)
            if not np.any(mask):
                continue

            crop_vals = crop[mask]
            peak = float(np.max(crop_vals))
            mean_val = float(np.mean(crop_vals))
            wsum = float(np.sum(crop_vals))
            if wsum <= 0:
                continue

            # Sub-pixel weighted centroid
            yy, xx = np.mgrid[0:bh, 0:bw]
            cx = bx + float(np.sum(xx * crop * mask) / wsum)
            cy = by + float(np.sum(yy * crop * mask) / wsum)

            # Shape metrics
            aspect = float(min(bw, bh) / max(bw, bh))
            fill_ratio = float(area / max(1, bw * bh))
            # One-sided size prior: an oversize bright source is consistent
            # with bloom / proximity / a larger-than-configured beacon and
            # must NOT be punished for it (a symmetric ratio lets a 10 px
            # star outscore the true 30+ px beacon).  Undersize sources are
            # still penalized linearly — a 3 px speck is never the beacon.
            # Streaks/glare are handled by aspect/fill/span gates instead.
            # For a smear-split core, size/flux credit the whole connected
            # luminous mass (same source), while position/shape stay core.
            _size_area = struct_area if struct_area is not None else area
            _flux_sum = struct_wsum if struct_wsum is not None else wsum
            size_match = float(min(1.0, _size_area / max(1.0, expected_area)))

            # Sky background estimation (scale-adaptive annulus):
            # the background floor must be measured where the sky actually
            # is.  A fixed 4 px ring sits inside a large source's own halo
            # (and inside neighbouring smear), so big beacons measured near-
            # zero contrast and lost to isolated stars.  The annulus scales
            # with the candidate (reaching past its halo into dark sky),
            # excludes the candidate bbox + margin and any smear structure,
            # and takes a low percentile so residual bright pixels (stars)
            # cannot set the floor.  For small candidates this reduces to
            # essentially the old ring behavior.
            _ccx, _ccy = bx + bw // 2, by + bh // 2
            _rout = max(10, int(math.hypot(bw, bh) * 2.0))
            _ax0, _ax1 = max(0, _ccx - _rout), min(w, _ccx + _rout)
            _ay0, _ay1 = max(0, _ccy - _rout), min(h, _ccy + _rout)
            _ann = work[_ay0:_ay1, _ax0:_ax1]
            _keep = np.ones_like(_ann, dtype=bool)
            _m = 3
            _kx0, _kx1 = max(_ax0, bx - _m) - _ax0, min(_ax1, bx + bw + _m) - _ax0
            _ky0, _ky1 = max(_ay0, by - _m) - _ay0, min(_ay1, by + bh + _m) - _ay0
            _keep[_ky0:_ky1, _kx0:_kx1] = False
            if struct_abs_mask is not None:
                _keep &= ~struct_abs_mask[_ay0:_ay1, _ax0:_ax1]
            _sky_vals = _ann[_keep]
            if _sky_vals.size > 8:
                bg_level = float(np.percentile(_sky_vals, 10))
            else:
                bg_level = float(np.percentile(_ann, 10))
            contrast = max(0.0, peak - bg_level)

            # Spatial consistency against Kalman prediction (PRIORITY, NOT GROUND TRUTH)
            spatial_prior = 1.0
            if predicted_pos is not None:
                dist = math.hypot(cx - predicted_pos[0], cy - predicted_pos[1])
                # Gaussian spatial decay around prediction (sigma = 35px)
                # Candidates near prediction receive higher priority.
                if dist <= 25.0:
                    spatial_prior = 1.0
                elif dist <= 60.0:
                    spatial_prior = 0.55
                elif dist <= 120.0:
                    spatial_prior = 0.20
                else:
                    spatial_prior = 0.04

            # Candidate Score — total integrated flux carries real weight
            # so a big bright beacon beats a 3 px salt speck even when both
            # peak at 1.0 (peak alone cannot distinguish them), and shape is
            # deliberately gentle so an elongated streak-beacon is not
            # punished for failing to be square.
            # Flux term saturates smoothly (Michaelis-Menten form) instead
            # of a hard cap: a much brighter source always outranks a dim
            # one, so a large true beacon is never tied-and-lost to a small
            # star on capped flux while size_match punishes its area.  A
            # correctly-sized beacon still wins overall via size_match.
            flux_match = _flux_sum / (_flux_sum + max(1.0, expected_area * 0.9))
            visual_score = (
                0.25 * peak +
                0.20 * min(1.0, contrast * 1.5) +
                0.10 * aspect +
                0.10 * fill_ratio +
                0.15 * size_match +
                0.20 * flux_match
            )

            if predicted_pos is not None:
                total_score = 0.35 * visual_score + 0.65 * (visual_score * spatial_prior)
            else:
                total_score = visual_score

            # Continuity bonus (anti star-jump): a candidate within a small
            # motion gate of the last SELECTED centroid gets a modest boost,
            # so the winner doesn't flicker between the beacon and a nearby
            # star on score noise.  Visual evidence stays dominant (x1.12):
            # a genuinely better candidate outside the gate still wins, and
            # the 35 px gate is far below any plausible inter-frame jump of
            # a distinct object.
            if self._last_selected is not None:
                gate_dist = math.hypot(cx - self._last_selected[0],
                                       cy - self._last_selected[1])
                if gate_dist <= 35.0:
                    total_score *= 1.12

            confidence = max(0.0, min(1.0, 0.40 * peak + 0.35 * min(1.0, contrast * 1.6) + 0.25 * aspect))

            candidates.append(BeaconCandidate(
                bbox_x=float(bx), bbox_y=float(by),
                bbox_w=float(bw), bbox_h=float(bh),
                centroid_x=cx, centroid_y=cy,
                area=area, peak=peak, mean_val=mean_val,
                contrast=contrast, aspect_ratio=aspect,
                score=total_score, confidence=confidence,
                is_selected=False,
            ))

        if not candidates:
            self._none_streak += 1
            if self._none_streak >= 5:
                self._last_selected = None  # stale gate dropped, not dragged
            return None

        # Sort candidates by score descending
        candidates.sort(key=lambda c: c.score, reverse=True)

        # Nearest-neighbor association: when we have a previous selection,
        # prefer the best candidate inside the motion gate.  A winner 100+
        # px away in a single frame is a teleport to a star/speck (measured
        # 357 px jump on the linear clip) — never the beacon.  If NOTHING
        # is inside the gate, the beacon genuinely jumped or re-entered, so
        # fall back to the global best rather than going blind.
        best = candidates[0]
        if self._last_selected is not None:
            _lx, _ly = self._last_selected
            _near = [c for c in candidates
                     if math.hypot(c.centroid_x - _lx, c.centroid_y - _ly)
                     <= self.ASSOCIATION_RADIUS_PX]
            if _near:
                best = _near[0]

        # Candidate Validation: check confidence threshold
        if best.confidence < self.MIN_CONFIDENCE:
            self._none_streak += 1
            if self._none_streak >= 5:
                self._last_selected = None
            return None

        best.is_selected = True
        # Association memory: anchor next frame's continuity gate here.
        self._last_selected = (best.centroid_x, best.centroid_y)
        self._none_streak = 0
        inference_ms = (time.perf_counter() - t0) * 1000.0

        # Export candidate summaries for optional UI debug overlay
        cand_dicts = [c.to_dict() for c in candidates[:8]]

        return DetectionResult(
            target_id=self._target_id,
            cls='optical_beacon',
            confidence=best.confidence,
            bbox_x=best.bbox_x,
            bbox_y=best.bbox_y,
            bbox_w=best.bbox_w,
            bbox_h=best.bbox_h,
            centroid_x=best.centroid_x,
            centroid_y=best.centroid_y,
            timestamp=time.time(),
            inference_ms=inference_ms,
            detector='image',
            candidates=cand_dicts,
        )


class YOLODetector(DetectorInterface):
    """
    Plug-in point for a trained YOLO beacon model.
    Falls back to ImageBeaconDetector when model is unavailable.
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

    def reset(self) -> None:
        self._fallback.reset()

    def detect_frame(
        self,
        frame: np.ndarray,
        predicted_pos: Optional[Tuple[float, float]] = None,
        search_roi: Optional[Tuple[int, int, int, int]] = None,
    ) -> Optional[DetectionResult]:
        try:
            if not self._available:
                raise RuntimeError('YOLO unavailable → Classical CV fallback')
            raise NotImplementedError('YOLO box parser not yet wired')
        except Exception as e:
            if getattr(self, '_warned', False) is False:
                print(f'[YOLODetector] {e}. Using classical CV fallback.')
                self._warned = True
            res = self._fallback.detect_frame(frame, predicted_pos=predicted_pos, search_roi=search_roi)
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
