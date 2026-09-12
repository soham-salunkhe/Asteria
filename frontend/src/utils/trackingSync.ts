/**
 * ASTERIA — 2D tracking ↔ 3D twin consistency math (pure, no Three.js).
 *
 * The 2D pipeline (detection → Kalman → PID → pan/tilt) is the SOLE
 * controller. These helpers only READ its telemetry output to validate that
 * the 3D digital twin reproduces it faithfully. They never command anything.
 *
 * Conventions mirror ai-service/simulation/camera.py exactly:
 *   optical axis = (sin(pan)·cos(tilt), sin(tilt), cos(pan)·cos(tilt))
 *   with pan/tilt in degrees and a YXZ (yaw-then-pitch) gimbal order.
 */
import type { TelemetryFrame } from '../types/fsoc';

export type V3Tuple = [number, number, number];

/** Fixed virtual-camera sensor geometry (matches the simulation config). */
export const SIM_RES_W = 640;
export const SIM_RES_H = 480;

export interface TrackingSyncSnapshot {
  pan: number;
  tilt: number;
  fovH: number;
  fovV: number;
  state: string;
  centroid: { x: number; y: number } | null;
  imgCenter: { x: number; y: number };
  errPx: { x: number; y: number } | null;
  camWorld: V3Tuple;
  beaconWorld: V3Tuple;
  /** Angle between the FSOC optical axis and the camera→beacon ray. */
  boresightDeg: number | null;
  /** Whether the (sim) beacon falls inside the true 4°×3° frustum. */
  inFov: boolean | null;
  /** The sim's own angular error, for cross-checking (should agree). */
  simTotalErrorDeg: number | null;
  /** FSOC optical forward unit vector (§1 authoritative frame). */
  forward: V3Tuple;
  /** Unit direction camera → beacon (§9 diagnostic). */
  toBeaconDir: V3Tuple | null;
  /** Beacon in the forward hemisphere (dot(F,D) > 0), cf. frustum cone. */
  inFront: boolean | null;
  /** Boresight decomposed into gimbal-frame horizontal/vertical errors. */
  angErrHDeg: number | null;
  angErrVDeg: number | null;
  /** Sim projection of the true beacon into the FSOC image plane (§22). */
  projPx: { x: number; y: number } | null;
  /** Measured centroid minus true projection (§22 agreement check). */
  projDeltaPx: { x: number; y: number } | null;
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Optical forward unit vector from pan/tilt (degrees), sim convention. */
export function opticalForward(panDeg: number, tiltDeg: number): V3Tuple {
  const pan = panDeg * D2R;
  const tilt = tiltDeg * D2R;
  return [
    Math.sin(pan) * Math.cos(tilt),
    Math.sin(tilt),
    Math.cos(pan) * Math.cos(tilt),
  ];
}

/**
 * Boresight error per spec §28: acos(clamp(dot(F, D))) in degrees, where
 * F = optical forward and D = normalize(beacon − camera). Null when the
 * geometry is degenerate (camera coincident with beacon).
 */
export function boresightErrorDeg(
  panDeg: number,
  tiltDeg: number,
  camWorld: V3Tuple,
  beaconWorld: V3Tuple,
): number | null {
  const F = opticalForward(panDeg, tiltDeg);
  const dx = beaconWorld[0] - camWorld[0];
  const dy = beaconWorld[1] - camWorld[1];
  const dz = beaconWorld[2] - camWorld[2];
  const len = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(len) || len < 1e-9) return null;
  const dot = clamp((F[0] * dx + F[1] * dy + F[2] * dz) / len, -1, 1);
  return Math.acos(dot) * R2D;
}

/**
 * True-frustum containment (§29): express the camera→beacon ray in the
 * gimbal frame (inverse YXZ rotation) and test half-angles against the
 * real FOV. Returns null on degenerate geometry.
 */
export function beaconInFov(
  panDeg: number,
  tiltDeg: number,
  fovHDeg: number,
  fovVDeg: number,
  camWorld: V3Tuple,
  beaconWorld: V3Tuple,
): boolean | null {
  const dx = beaconWorld[0] - camWorld[0];
  const dy = beaconWorld[1] - camWorld[1];
  const dz = beaconWorld[2] - camWorld[2];
  const len = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(len) || len < 1e-9) return null;
  // Inverse gimbal rotation: first yaw back by −pan about Y, then pitch
  // back by +tilt about X (inverse of forward YXZ with pitch −tilt).
  const pan = panDeg * D2R;
  const cp = Math.cos(pan);
  const sp = Math.sin(pan);
  const x1 = cp * dx - sp * dz;
  const z1 = sp * dx + cp * dz;
  const y1 = dy;
  const tilt = tiltDeg * D2R;
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  // Forward used pitch −tilt, so the inverse pitches by +tilt:
  // rotating (x1, y1, z1) about X by +tilt maps the axis back to +Z.
  const y2 = ct * y1 - st * z1;
  const z2 = st * y1 + ct * z1;
  if (!(z2 > 0)) return false; // behind the aperture plane
  const halfH = Math.abs(fovHDeg) / 2;
  const halfV = Math.abs(fovVDeg) / 2;
  return (
    Math.abs(Math.atan2(x1, z2) * R2D) <= halfH &&
    Math.abs(Math.atan2(y2, z2) * R2D) <= halfV
  );
}

/**
 * 3D marker for a VIDEO_INPUT beacon (MP4 provides x/y/time only — never
 * 3D coordinates). Back-projects the measured detector centroid through
 * the CURRENT virtual pan/tilt at a fixed visualization depth, so the 3D
 * twin shows where the video-tracked beacon sits inside the FOV cone.
 * Visualization ONLY: never fed into detection, Kalman, PID or reports.
 * Returns null unless the frame is a video frame with a valid detection.
 */
export function videoBeaconMarker(
  frame: TelemetryFrame | null,
  camWorld: V3Tuple,
  depthWorld = 3.0,
): V3Tuple | null {
  if (!frame || (frame.source ?? 'virtual') !== 'video_input') return null;
  const det = frame.detection;
  const cx = det?.centroid?.x;
  const cy = det?.centroid?.y;
  if (typeof cx !== 'number' || typeof cy !== 'number') return null;
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  const fovH = frame.camera?.fov_h ?? 4;
  const fovV = frame.camera?.fov_v ?? 3;
  if (!(fovH > 0) || !(fovV > 0)) return null;
  const pan = frame.camera?.pan ?? 0;
  const tilt = frame.camera?.tilt ?? 0;
  // Pixel offset → gimbal-frame ray (inverse of the sim's pixel projection;
  // pixel +y is down while tilt + is up).
  const ah = ((cx - SIM_RES_W / 2) / SIM_RES_W) * fovH * D2R;
  const av = (-(cy - SIM_RES_H / 2) / SIM_RES_H) * fovV * D2R;
  const th = Math.tan(ah);
  const tv = Math.tan(av);
  const il = Math.hypot(th, tv, 1);
  const dl: V3Tuple = [th / il, tv / il, 1 / il];
  // Forward gimbal rotation YXZ (yaw pan, pitch −tilt), same as the rig.
  const p = pan * D2R;
  const t = tilt * D2R;
  const cp = Math.cos(p);
  const sp = Math.sin(p);
  const ct = Math.cos(t);
  const st = Math.sin(t);
  const y1 = ct * dl[1] + st * dl[2];
  const z1 = -st * dl[1] + ct * dl[2];
  const dir: V3Tuple = [cp * dl[0] + sp * z1, y1, -sp * dl[0] + cp * z1];
  const out: V3Tuple = [
    camWorld[0] + dir[0] * depthWorld,
    camWorld[1] + dir[1] * depthWorld,
    camWorld[2] + dir[2] * depthWorld,
  ];
  if (!out.every(Number.isFinite)) return null;
  return out;
}

/**
 * Build the full 2D↔3D sync snapshot from one telemetry frame.
 *
 * satWorld: world-space position of the satellite hosting the active
 * camera (falls back to SAT_A default when unknown). aperture: the
 * optical aperture offset in the host frame. worldScale maps sim metres
 * to Three.js world units with the SAT_A origin. beaconWorld uses the
 * TRUE sim beacon (target position + operator offset) — the entity the
 * controller actually tracks.
 */
export function computeTrackingSync(
  frame: TelemetryFrame | null,
  satWorld: V3Tuple | null,
  aperture: V3Tuple,
  satOrigin: V3Tuple,
  worldScale: number,
  beaconWorldOverride?: V3Tuple | null,
): TrackingSyncSnapshot | null {
  if (!frame) return null;
  const pan = frame.camera?.pan ?? 0;
  const tilt = frame.camera?.tilt ?? 0;
  const fovH = frame.camera?.fov_h ?? 4;
  const fovV = frame.camera?.fov_v ?? 3;
  const host = satWorld ?? satOrigin;
  const camWorld: V3Tuple = [
    host[0] + aperture[0],
    host[1] + aperture[1],
    host[2] + aperture[2],
  ];
  const tp = frame.target?.position;
  const off = frame.target_offset ?? { x: 0, y: 0, z: 0 };
  // Explicit override (e.g. the video-beacon marker) wins; otherwise the
  // true sim beacon. Falls back to the aperture point when unknown.
  const beaconWorld: V3Tuple = beaconWorldOverride ?? (tp
    ? ([
        satOrigin[0] + (tp.x + (off.x ?? 0)) * worldScale,
        satOrigin[1] + (tp.y + (off.y ?? 0)) * worldScale,
        satOrigin[2] + (tp.z + (off.z ?? 0)) * worldScale,
      ] as V3Tuple)
    : [...camWorld] as V3Tuple);
  const det = frame.detection ?? null;
  const centroid = det ? { x: det.centroid.x, y: det.centroid.y } : null;
  // Authoritative optical frame (§1/§9): forward from live pan/tilt, beacon
  // ray from world geometry. Both feed boresight, containment and display.
  const F = opticalForward(pan, tilt);
  const dx = beaconWorld[0] - camWorld[0];
  const dy = beaconWorld[1] - camWorld[1];
  const dz = beaconWorld[2] - camWorld[2];
  const rayLen = Math.hypot(dx, dy, dz);
  const rayOk = Number.isFinite(rayLen) && rayLen >= 1e-9;
  const toBeaconDir: V3Tuple | null = rayOk
    ? [dx / rayLen, dy / rayLen, dz / rayLen]
    : null;
  const inFront = toBeaconDir
    ? (F[0] * toBeaconDir[0] + F[1] * toBeaconDir[1] + F[2] * toBeaconDir[2]) > 0
    : null;
  // Gimbal-frame decomposition of the residual (same inverse rotation as
  // containment): horizontal/vertical angular errors in degrees.
  let angErrHDeg: number | null = null;
  let angErrVDeg: number | null = null;
  if (toBeaconDir) {
    const p = pan * D2R;
    const t = tilt * D2R;
    const cp = Math.cos(p);
    const sp = Math.sin(p);
    const ct = Math.cos(t);
    const st = Math.sin(t);
    const x1 = cp * toBeaconDir[0] - sp * toBeaconDir[2];
    const z1 = sp * toBeaconDir[0] + cp * toBeaconDir[2];
    const y2 = ct * toBeaconDir[1] - st * z1;
    const z2 = st * toBeaconDir[1] + ct * z1;
    if (z2 > 0) {
      angErrHDeg = Math.atan2(x1, z2) * R2D;
      angErrVDeg = Math.atan2(y2, z2) * R2D;
    }
  }
  const ce = frame.centroiding_error ?? null;
  const projPx = ce?.target_px_x != null && ce?.target_px_y != null
    ? { x: ce.target_px_x, y: ce.target_px_y }
    : null;
  const projDeltaPx = ce?.pixel_error_x != null && ce?.pixel_error_y != null
    ? { x: ce.pixel_error_x, y: ce.pixel_error_y }
    : null;
  return {
    pan,
    tilt,
    fovH,
    fovV,
    state: frame.target_state,
    centroid,
    imgCenter: { x: SIM_RES_W / 2, y: SIM_RES_H / 2 },
    errPx: centroid
      ? { x: centroid.x - SIM_RES_W / 2, y: centroid.y - SIM_RES_H / 2 }
      : null,
    camWorld,
    beaconWorld,
    boresightDeg: boresightErrorDeg(pan, tilt, camWorld, beaconWorld),
    inFov: beaconInFov(pan, tilt, fovH, fovV, camWorld, beaconWorld),
    simTotalErrorDeg: frame.angular_error?.total_error ?? null,
    forward: F,
    toBeaconDir,
    inFront,
    angErrHDeg,
    angErrVDeg,
    projPx,
    projDeltaPx,
  };
}
