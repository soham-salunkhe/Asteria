/**
 * ASTERIA — PS169 Single Source of Truth (frontend).
 *
 * MANDATORY BASELINE:
 *   640x480 · HFOV 4° · VFOV 3° · ACQ ≤2s · ERR ≤10px ·
 *   LOSS <5% · REACQ ≤1s · FPS ≥20 · VIDEO 30FPS
 *
 * Every component (detector, camera, tracker, PID, analytics, reports,
 * UI, performance panel) must import from here — never duplicate magic
 * numbers. UI/configuration uses degrees; Three.js uses radians (convert
 * at the boundary with degToRad/radToDeg).
 */

export const PS169_CONFIG = {
  camera: {
    width: 640,
    height: 480,
    centerX: 320,
    centerY: 240,
    horizontalFovDeg: 4,
    verticalFovDeg: 3,
    fps: 30,
  },
  performance: {
    maxAcquisitionTimeSec: 2,
    maxTrackingErrorPx: 10,
    maxTargetLossPercent: 5,
    maxReacquisitionTimeSec: 1,
    minFps: 20,
  },
  video: { expectedFps: 30 },
  gimbal: {
    panMinDeg: -180,
    panMaxDeg: 180,
    // +/-90° is the gimbal singularity; 89° is the safe operating limit.
    tiltMinDeg: -89,
    tiltMaxDeg: 89,
    maxPanRateDegPerSec: 5,
    maxTiltRateDegPerSec: 5,
  },
  pid: {
    kp: 6.0,
    ki: 0.15,
    kd: 0.6,
    integralLimit: 20.0,
    maxVelDegPerSec: 5.0,
    settlingDeg: 0.05,
    outputUnits: 'deg/sec' as const,
  },
  kalman: { q: 2.0, r: 5.0, p0: 500.0 },
  beam: {
    length: 2.0,
    radius: 0.008,
    opacityLocked: 0.35,
    opacitySearch: 0.22,
  },
} as const;

export const degToRad = (deg: number): number => (deg * Math.PI) / 180;
export const radToDeg = (rad: number): number => (rad * 180) / Math.PI;

/** Wrap to [-180, +180] so 179° → -180° never causes a controller jump. */
export function normalizeAngleDeg(angle: number): number {
  let a = ((angle + 180) % 360 + 360) % 360;
  return a - 180;
}

/** Shortest signed angular difference in [-180, +180]. */
export function angleErrorDeg(target: number, current: number): number {
  return normalizeAngleDeg(target - current);
}

/** Unit optical-forward vector from pan/tilt (degrees). Never zero-length. */
export function opticalForward(
  panDeg: number,
  tiltDeg: number,
): [number, number, number] {
  const p = degToRad(panDeg);
  const t = degToRad(tiltDeg);
  return [Math.sin(p) * Math.cos(t), Math.sin(t), Math.cos(p) * Math.cos(t)];
}

/** Validate the running configuration at START DEMO; returns error strings. */
export function validatePs169Config(opts?: {
  width?: number;
  height?: number;
  fovH?: number;
  fovV?: number;
}): string[] {
  const errors: string[] = [];
  const w = opts?.width ?? PS169_CONFIG.camera.width;
  const h = opts?.height ?? PS169_CONFIG.camera.height;
  if (w !== 640 || h !== 480) errors.push(`Resolution must be 640x480, got ${w}x${h}`);
  const fh = opts?.fovH ?? PS169_CONFIG.camera.horizontalFovDeg;
  const fv = opts?.fovV ?? PS169_CONFIG.camera.verticalFovDeg;
  if (fh !== 4) errors.push(`HFOV must be 4°, got ${fh}°`);
  if (fv !== 3) errors.push(`VFOV must be 3°, got ${fv}°`);
  return errors;
}
