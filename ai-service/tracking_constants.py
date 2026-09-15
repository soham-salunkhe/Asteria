"""
FSOC PAT — PS169 Single Source of Truth.

MANDATORY BASELINE (PS169):
  Camera: 640 x 480, HFOV 4 deg, VFOV 3 deg
  Performance: acquisition <= 2 s, tracking error <= 10 px,
               target loss < 5 %, reacquisition <= 1 s, FPS >= 20
  Video: 30 FPS MP4 input

Every component (detector, camera, tracker, PID, analytics, reports,
UI, performance panel) must reference these values — never duplicate
magic numbers elsewhere.

Conventions:
  UI/configuration: degrees.  Three.js / trig: radians (convert at boundary).
  Pan  = azimuth  [-180, +180] deg.  Tilt = elevation [-89, +89] deg
         (89 deg safe limit avoids the +/-90 deg gimbal singularity).
  PID output: deg/sec, integrated with dt (never frame-rate dependent).
  Pixel origin: top-left. Image centre: (320, 240).
"""

import math

# ── Camera ────────────────────────────────────────────────────
CAMERA_WIDTH: int = 640
CAMERA_HEIGHT: int = 480
IMAGE_CENTER_X: float = 320.0
IMAGE_CENTER_Y: float = 240.0
HORIZONTAL_FOV_DEG: float = 4.0
VERTICAL_FOV_DEG: float = 3.0
CAMERA_FPS: float = 30.0

# ── Performance requirements (PS169) ──────────────────────────
MAX_ACQUISITION_TIME_SEC: float = 2.0
MAX_TRACKING_ERROR_PX: float = 10.0
MAX_TARGET_LOSS_PERCENT: float = 5.0
MAX_REACQUISITION_TIME_SEC: float = 1.0
MIN_FPS: float = 20.0

# ── Video ─────────────────────────────────────────────────────
VIDEO_EXPECTED_FPS: float = 30.0

# ── Gimbal workspace ──────────────────────────────────────────
PAN_MIN_DEG: float = -180.0
PAN_MAX_DEG: float = 180.0
# +/-90 deg is the mathematical singularity; 89 deg is the safe
# internal operating limit (documented, consistent everywhere).
TILT_MIN_DEG: float = -89.0
TILT_MAX_DEG: float = 89.0
MAX_PAN_RATE_DEG_PER_SEC: float = 5.0
MAX_TILT_RATE_DEG_PER_SEC: float = 5.0

# ── Tracking thresholds (pixel domain) ────────────────────────
TARGET_LOCK_THRESHOLD_PX: float = 10.0
TARGET_UNLOCK_PX: float = 20.0
LOCK_FRAMES_REQUIRED: int = 10
ACQUIRING_THRESHOLD_PX: float = 40.0

# ── Loss / reacquisition ──────────────────────────────────────
LOST_GRACE_SECONDS: float = 3.0
# Catastrophic-failure safety only — NEVER reported as a successful
# PS169 reacquisition (which must be <= 1 s and measured separately).
REACQUIRE_TIMEOUT_SECONDS: float = 10.0
COAST_SECONDS: float = 1.0

# ── Search sweep ──────────────────────────────────────────────
SEARCH_MIN_PAN_DEG: float = 12.0
SEARCH_MAX_PAN_DEG: float = 180.0
SEARCH_RAMP_SEC: float = 12.0
SEARCH_RATE_RAD_PER_SEC: float = 0.55
SEARCH_TILT_RATE_RAD_PER_SEC: float = 0.42
SEARCH_MIN_TILT_DEG: float = 3.0
SEARCH_MAX_TILT_DEG: float = 45.0

# ── PID (authoritative runtime tuning, deg/sec output) ────────
PID_KP: float = 8.0
PID_KI: float = 0.15
PID_KD: float = 0.9
# Max gimbal slew rate.  Must be high enough for fast-moving beacon acquisition.
# A 640x480 sensor with 4-deg HFOV = 160 px/deg.  Beacon can move ~50px/frame
# (at 30 fps), which needs ≥50px/frame = 1500 px/s = 9.4 deg/s minimum.
PID_MAX_VEL_DEG_PER_SEC: float = 15.0   # used during acquisition slew
PID_MAX_VEL_LOCKED_DEG_PER_SEC: float = 8.0  # tightened once LOCKED for stability
# Video-mode PID approach rate: caps the P-implied slew while closing on
# the beacon.  Raw-residual P alone would slam at up to 15 deg/s and
# limit-cycle (measured 666 px spikes); 2.5 deg/s keeps ~10x margin over
# typical beacon drift while the D term self-limits arrival.
PID_APPROACH_RATE_DEG_PER_SEC: float = 2.5
# Derivative low-pass alpha for PIDAxis (see control/pid.py): pixel
# quantization otherwise thrashes the D sign frame-to-frame.
PID_D_FILTER_ALPHA: float = 0.7
# Feedforward lead (video loop): compensates one frame of actuation delay
# plus velocity-estimator lag on fast (400+ px/s) targets.  Pure velocity
# match (1.0) leaves the standing lag for P to carry; ~1.2 closes it.
# MEASURED: FF_LEAD=1.2 + EMA 0.65 regressed figure-8 turnarounds
# (93.2→87.9% retention, mean 7.7→9.3px — lead over-pushes velocity
# reversals).  Reverted to 1.0/0.5 until a turnaround-aware
# (acceleration-gated) lead is proven on data.  Kept single-sourced here
# so the experiment is one constant flip.
FF_LEAD: float = 1.0
# EMA alpha 0.65 (was 0.5): error-mass analysis shows RMSE dominated by
# reversal transients (persistent fast segments + sharp turns), not lag —
# faster adaptation tracks turns sooner.  Tried 0.65 WITH lead 1.2 before
# and regressed (over-push); this tests 0.65 with lead 1.0.  Keep iff 08
# improves without figure-8 regressing >0.5px.
FF_VEL_EMA_ALPHA: float = 0.65
# Phase-aware FF authority (video loop): scales feedforward by the cosine
# between residual vector and velocity vector, bounded to 1±authority.
# Lagging (aligned) → push harder; turnaround overshoot (opposed) →
# self-brake.  Worst case equals unscaled behavior.
FF_ALIGN_AUTHORITY: float = 0.25
# Control deadband in pixels (video loop): inside this radius the PID
# errors are held at zero so quantization jitter is not chased.
# Feedforward still tracks motion; metrics record the true residual.
CONTROL_DEADBAND_PX: float = 1.5
PID_SETTLING_DEG: float = 0.05
PID_INTEGRAL_LIMIT: float = 20.0

# ── Kalman (pixel domain, dt always time-based) ───────────────
KALMAN_Q: float = 2.0
KALMAN_R: float = 3.5
KALMAN_P0: float = 500.0

# ── Beam visualisation (subtle, direction-only) ───────────────
BEAM_LENGTH: float = 2.0
BEAM_RADIUS: float = 0.008
BEAM_OPACITY_LOCKED: float = 0.35
BEAM_OPACITY_SEARCH: float = 0.22

# ── Authoritative dict (mirrors the PS169_CONFIG concept) ─────
PS169_CONFIG: dict = {
    "camera": {
        "width": CAMERA_WIDTH,
        "height": CAMERA_HEIGHT,
        "horizontalFovDeg": HORIZONTAL_FOV_DEG,
        "verticalFovDeg": VERTICAL_FOV_DEG,
    },
    "performance": {
        "maxAcquisitionTimeSec": MAX_ACQUISITION_TIME_SEC,
        "maxTrackingErrorPx": MAX_TRACKING_ERROR_PX,
        "maxTargetLossPercent": MAX_TARGET_LOSS_PERCENT,
        "maxReacquisitionTimeSec": MAX_REACQUISITION_TIME_SEC,
        "minFps": MIN_FPS,
    },
    "video": {"expectedFps": VIDEO_EXPECTED_FPS},
    "gimbal": {
        "panMinDeg": PAN_MIN_DEG,
        "panMaxDeg": PAN_MAX_DEG,
        "tiltMinDeg": TILT_MIN_DEG,
        "tiltMaxDeg": TILT_MAX_DEG,
        "maxPanRateDegPerSec": MAX_PAN_RATE_DEG_PER_SEC,
        "maxTiltRateDegPerSec": MAX_TILT_RATE_DEG_PER_SEC,
    },
    "pid": {
        "kp": PID_KP, "ki": PID_KI, "kd": PID_KD,
        "integralLimit": PID_INTEGRAL_LIMIT,
        "maxVelDegPerSec": PID_MAX_VEL_DEG_PER_SEC,
        "settlingDeg": PID_SETTLING_DEG,
        "outputUnits": "deg/sec",
    },
    "kalman": {"q": KALMAN_Q, "r": KALMAN_R, "p0": KALMAN_P0},
}


# ── Angle helpers (single place for deg/rad + wrap) ───────────
def deg_to_rad(deg: float) -> float:
    return deg * math.pi / 180.0


def rad_to_deg(rad: float) -> float:
    return rad * 180.0 / math.pi


def normalize_angle_deg(angle: float) -> float:
    """Wrap to [-180, +180] so 179 -> -180 never causes a jump."""
    a = math.fmod(angle + 180.0, 360.0)
    if a < 0:
        a += 360.0
    return a - 180.0


def angle_error_deg(target: float, current: float) -> float:
    """Shortest signed angular difference in [-180, +180]."""
    return normalize_angle_deg(target - current)


def optical_forward(pan_deg: float, tilt_deg: float) -> tuple[float, float, float]:
    """Unit optical-forward vector from pan/tilt (deg). Never zero-length."""
    p = deg_to_rad(pan_deg)
    t = deg_to_rad(tilt_deg)
    return (
        math.sin(p) * math.cos(t),
        math.sin(t),
        math.cos(p) * math.cos(t),
    )


def pixel_error_to_gimbal_error(pixel_error_x: float, pixel_error_y: float) -> tuple[float, float]:
    """Convert image error into the authoritative pan/tilt command error.

    Image coordinates are x-right/y-down while a positive FSOC tilt raises
    the optical axis.  Thus a beacon above centre has a negative image-Y
    error and requires a *positive* tilt command; raising the camera moves
    that beacon down in the sensor image.  This is the only sign inversion
    at the image-to-gimbal boundary.
    """
    pan_error = pixel_error_x / (CAMERA_WIDTH / HORIZONTAL_FOV_DEG)
    tilt_error = -pixel_error_y / (CAMERA_HEIGHT / VERTICAL_FOV_DEG)
    return pan_error, tilt_error


def boresight_deg(
    fwd: tuple[float, float, float],
    to_beacon: tuple[float, float, float],
) -> float | None:
    """Angular separation between optical axis and beacon direction."""
    fl = math.sqrt(sum(c * c for c in fwd))
    bl = math.sqrt(sum(c * c for c in to_beacon))
    if fl < 0.99 or fl > 1.01 or bl < 1e-9:
        return None
    dot = sum(a * b for a, b in zip(fwd, to_beacon)) / (fl * bl)
    dot = max(-1.0, min(1.0, dot))
    return rad_to_deg(math.acos(dot))


def validate_ps169_config() -> list[str]:
    """Startup validation — returns a list of error strings (empty = OK)."""
    errors: list[str] = []
    if (CAMERA_WIDTH, CAMERA_HEIGHT) != (640, 480):
        errors.append(f"Resolution must be 640x480, got {CAMERA_WIDTH}x{CAMERA_HEIGHT}")
    if HORIZONTAL_FOV_DEG != 4.0:
        errors.append(f"HFOV must be 4 deg, got {HORIZONTAL_FOV_DEG}")
    if VERTICAL_FOV_DEG != 3.0:
        errors.append(f"VFOV must be 3 deg, got {VERTICAL_FOV_DEG}")
    if not (PAN_MIN_DEG < PAN_MAX_DEG and PAN_MIN_DEG >= -180 and PAN_MAX_DEG <= 180):
        errors.append(f"Invalid PAN limits {PAN_MIN_DEG}..{PAN_MAX_DEG}")
    if not (TILT_MIN_DEG < TILT_MAX_DEG and abs(TILT_MAX_DEG) <= 89 and abs(TILT_MIN_DEG) <= 89):
        errors.append(f"Invalid TILT limits {TILT_MIN_DEG}..{TILT_MAX_DEG} (safe range +/-89)")
    for name, v in [("PID_KP", PID_KP), ("PID_KI", PID_KI), ("PID_KD", PID_KD)]:
        if not math.isfinite(v):
            errors.append(f"{name} must be finite, got {v}")
    for name, v in [("KALMAN_Q", KALMAN_Q), ("KALMAN_R", KALMAN_R), ("KALMAN_P0", KALMAN_P0)]:
        if not math.isfinite(v) or v <= 0:
            errors.append(f"{name} must be finite positive, got {v}")
    if MIN_FPS < 20:
        errors.append(f"MIN_FPS must be >= 20, got {MIN_FPS}")
    return errors
