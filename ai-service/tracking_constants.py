"""
FSOC PAT — PS169 Tracking Constants
Single authoritative source for all pixel-level tracking thresholds.

Both SimulationEngine and VideoProcessor import from here so that
tuning one value automatically applies to all benchmarks.

PS169 reference:
  Row 17 — Tracking Error ≤ 10 pixels
"""

# Pixel error at which the camera is considered on-target
TARGET_LOCK_THRESHOLD_PX: float = 10.0

# Pixel error above which the lock count is reset (small hysteresis)
TARGET_UNLOCK_PX: float = 15.0

# Consecutive frames within threshold before transitioning to LOCKED
LOCK_FRAMES_REQUIRED: int = 15

# Pixel error below which state transitions from DETECTED → ACQUIRING
ACQUIRING_THRESHOLD_PX: float = 40.0

# Seconds of consecutive misses before declaring TARGET LOST
LOST_GRACE_SECONDS: float = 3.0

# Seconds allowed in REACQUIRING before returning to SEARCHING
REACQUIRE_TIMEOUT_SECONDS: float = 10.0
