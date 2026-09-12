/**
 * FSOC — Camera Feed
 * Renders a realistic synthetic camera view:
 *   - Sky/ground scene with atmospheric gradient
 *   - Glowing optical beacon (actual point of light that moves)
 *   - Star-field background (night/dusk scenario)
 *   - Camera noise texture
 *   - Detection bounding box with corner brackets
 *   - Kalman predicted position
 *   - Tracking reticle (follows camera centre)
 *   - Angular error indicator
 *   - HUD overlays
 */
import React, { useRef, useEffect } from 'react';
import type { TelemetryFrame, TargetState } from '../../types/fsoc';

const STATE_COLOR: Record<TargetState, string> = {
  READY: '#626a6d', SEARCHING: '#e39a32', DETECTED: '#f0b35a',
  ACQUIRING: '#f0b35a', TRACKING: '#8fa98f', LOCKED: '#8fa98f',
  LOST: '#a86a5a', REACQUIRING: '#e39a32', ERROR: '#a86a5a',
};

// Pre-generate a sparse static star field — minimal, terminal-style
const STARS = Array.from({ length: 42 }, (_, i) => ({
  x: ((i * 137.508 + 50) % 640),
  y: ((i * 97.3 + 30)  % 480),
  r: 0.4 + (i % 5) * 0.25,
  a: 0.2 + (i % 7) * 0.1,
}));

// ── Pre-rendered static starfield (drawn once, blitted each frame) ──
let _starfieldCanvas: HTMLCanvasElement | null = null;
function getStarfieldCanvas(W: number, H: number): HTMLCanvasElement {
  if (_starfieldCanvas && _starfieldCanvas.width === W && _starfieldCanvas.height === H) {
    return _starfieldCanvas;
  }
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  if (ctx) {
    STARS.forEach(s => {
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(200,220,220,${s.a})`;
      ctx.fill();
    });
  }
  _starfieldCanvas = c;
  return c;
}

// ── Pre-rendered scanline overlay (drawn once, blitted each frame) ──
let _scanlineCanvas: HTMLCanvasElement | null = null;
function getScanlineCanvas(W: number, H: number): HTMLCanvasElement {
  if (_scanlineCanvas && _scanlineCanvas.width === W && _scanlineCanvas.height === H) {
    return _scanlineCanvas;
  }
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    for (let sy = 0; sy < H; sy += 3) {
      ctx.fillRect(0, sy, W, 1);
    }
  }
  _scanlineCanvas = c;
  return c;
}

// ── Fast Zero-Allocation Noise Pool (GPU Canvas Blit) ────────
const NOISE_W = 160;
const NOISE_H = 120;
const GAUSSIAN_NOISE_POOL: HTMLCanvasElement[] = [];
const POISSON_NOISE_POOL: HTMLCanvasElement[] = [];

function createNoisePattern(type: 'gaussian' | 'poisson'): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = NOISE_W;
  c.height = NOISE_H;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const img = ctx.createImageData(NOISE_W, NOISE_H);
  const d = img.data;

  if (type === 'poisson') {
    for (let i = 0; i < d.length; i += 4) {
      const u1 = Math.random() || 1e-10;
      const u2 = Math.random();
      const n = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * 22;
      const v = Math.min(255, Math.max(0, Math.round(n)));
      d[i] = v; d[i+1] = v; d[i+2] = v;
      d[i+3] = v > 6 ? Math.min(160, v * 2) : 0;
    }
  } else {
    // Gaussian
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.min(255, Math.max(0, Math.round((Math.random() - 0.5) * 70 + 35)));
      d[i] = v; d[i+1] = v; d[i+2] = v;
      d[i+3] = Math.random() < 0.25 ? 120 : 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function getNoisePool(type: 'gaussian' | 'poisson'): HTMLCanvasElement[] {
  const pool = type === 'gaussian' ? GAUSSIAN_NOISE_POOL : POISSON_NOISE_POOL;
  if (pool.length === 0) {
    for (let i = 0; i < 4; i++) {
      pool.push(createNoisePattern(type));
    }
  }
  return pool;
}

interface Props {
  frame: TelemetryFrame | null;
  width?: number;
  height?: number;
  /** Atmospheric visual mode — drives overlay effect */
  atmosMode?: 'clear' | 'haze' | 'fog' | 'rain' | 'low_light';
  noiseMode?: 'gaussian' | 'salt_pepper' | 'poisson' | 'none';
  /** Beacon shape — PS4 default is square */
  beaconShape?: 'square' | 'circle';
  /** Beacon size in pixels (PS4 spec: 5–20px, default 10) */
  beaconSize?: number;
}

export function CameraFeed({
  frame, width = 640, height = 480,
  atmosMode = 'clear', noiseMode = 'gaussian',
  beaconShape = 'square', beaconSize = 10,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Smooth beacon pos with lerp to avoid jitter
  const beaconPos = useRef({ x: 320, y: 240 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const CX = W / 2;
    const CY = H / 2;

    const state = (frame?.target_state ?? 'READY') as TargetState;
    const stateColor = STATE_COLOR[state] ?? '#626a6d';
    const isLocked = state === 'LOCKED' || state === 'TRACKING';

    // ── 1. Scene background ──────────────────────────────────
    // Deep-space terminal black, neutral (no teal/green cast)
    const skyGrad = ctx.createLinearGradient(0, 0, 0, H);
    skyGrad.addColorStop(0,   '#080a0c');
    skyGrad.addColorStop(0.55,'#0b0e11');
    skyGrad.addColorStop(1,   '#0d1013');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, W, H);

    // Horizon glow (faint warm amber, terminal-style)
    const horizGrad = ctx.createLinearGradient(0, H * 0.6, 0, H);
    horizGrad.addColorStop(0, 'rgba(0,0,0,0)');
    horizGrad.addColorStop(1, 'rgba(217,134,24,0.08)');
    ctx.fillStyle = horizGrad;
    ctx.fillRect(0, H * 0.6, W, H * 0.4);

    // ── 2. Stars (pre-rendered offscreen canvas — single blit) ──
    ctx.drawImage(getStarfieldCanvas(W, H), 0, 0);

    // ── 3. Camera noise texture (Zero-allocation GPU-accelerated blit) ──
    const noiseLevel = frame?.disturbance?.config?.sensor_noise?.enabled
      ? (frame.disturbance.config.sensor_noise.noise_level ?? 0.02)
      : 0.015;
    const effectiveNoiseMode = frame?.disturbance?.config?.sensor_noise?.enabled ? noiseMode : 'gaussian';

    if (noiseLevel > 0 && effectiveNoiseMode !== 'none') {
      const fid = frame?.frame_id ?? 0;

      if (effectiveNoiseMode === 'salt_pepper') {
        // Fast sparse salt-and-pepper: 0 allocation, O(specks) instead of O(pixels)
        const count = Math.min(300, Math.floor(noiseLevel * 600));
        ctx.save();
        for (let i = 0; i < count; i++) {
          const rx = (Math.random() * W) | 0;
          const ry = (Math.random() * H) | 0;
          ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.85)';
          ctx.fillRect(rx, ry, 1.2, 1.2);
        }
        ctx.restore();
      } else {
        // Gaussian & Poisson: GPU draw from pre-generated texture pool
        const pool = getNoisePool(effectiveNoiseMode === 'poisson' ? 'poisson' : 'gaussian');
        const patternCanvas = pool[fid % pool.length];
        if (patternCanvas) {
          ctx.save();
          ctx.globalAlpha = Math.min(0.9, noiseLevel * 3.8);
          ctx.globalCompositeOperation = 'screen';
          // Slight jitter so grain dances across frames
          const jx = ((fid * 17) % 16) - 8;
          const jy = ((fid * 23) % 16) - 8;
          ctx.drawImage(patternCanvas, jx, jy, W, H);
          ctx.restore();
        }
      }
    }

    // ── 4. Beacon (the actual moving light source) ─────────────
    const imgPos = frame?.target?.image_position;
    if (imgPos) {
      beaconPos.current.x += (imgPos.x - beaconPos.current.x) * 0.25;
      beaconPos.current.y += (imgPos.y - beaconPos.current.y) * 0.25;
    }
    const bx = beaconPos.current.x;
    const by = beaconPos.current.y;
    const half = beaconSize / 2;

    if (bx > 0 && bx < W && by > 0 && by < H) {
      // Outer atmospheric halo (shared for both shapes)
      const haloR = isLocked ? 28 : 22;
      const halo = ctx.createRadialGradient(bx, by, 0, bx, by, haloR);
      halo.addColorStop(0,   isLocked ? 'rgba(120,240,160,0.35)' : 'rgba(100,200,255,0.3)');
      halo.addColorStop(0.5, isLocked ? 'rgba(80,200,120,0.12)'  : 'rgba(60,160,240,0.1)');
      halo.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.arc(bx, by, haloR, 0, Math.PI * 2);
      ctx.fillStyle = halo;
      ctx.fill();

      if (beaconShape === 'square') {
        // ── Square beacon (PS4 spec default) ────────────────
        // Glow shadow
        ctx.shadowColor = isLocked ? '#80ffb0' : '#80d0ff';
        ctx.shadowBlur = 16;
        // Core bright square
        ctx.fillStyle = isLocked ? '#ccffdd' : '#cceeff';
        ctx.fillRect(bx - half, by - half, beaconSize, beaconSize);
        // Inner brighter centre
        const cSize = Math.max(2, beaconSize * 0.4);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(bx - cSize/2, by - cSize/2, cSize, cSize);
        ctx.shadowBlur = 0;
        // Outline
        ctx.strokeStyle = isLocked ? 'rgba(100,255,160,0.9)' : 'rgba(100,200,255,0.8)';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx - half, by - half, beaconSize, beaconSize);
        // Diffraction spikes
        const spikeLen = isLocked ? beaconSize + 10 : beaconSize + 6;
        const spikeAlpha = isLocked ? 0.55 : 0.35;
        ctx.strokeStyle = `rgba(200,230,255,${spikeAlpha})`;
        ctx.lineWidth = 0.8;
        [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dx,dy]) => {
          ctx.beginPath();
          ctx.moveTo(bx + dx * (half + 1), by + dy * (half + 1));
          ctx.lineTo(bx + dx * spikeLen,   by + dy * spikeLen);
          ctx.stroke();
        });
      } else {
        // ── Circle beacon (original glow) ──────────────────
        const midGlow = ctx.createRadialGradient(bx, by, 0, bx, by, 9);
        midGlow.addColorStop(0,   isLocked ? 'rgba(180,255,200,0.9)' : 'rgba(160,220,255,0.85)');
        midGlow.addColorStop(0.4, isLocked ? 'rgba(60,220,100,0.6)'  : 'rgba(80,180,255,0.55)');
        midGlow.addColorStop(1,   'rgba(0,0,0,0)');
        ctx.beginPath();
        ctx.arc(bx, by, 9, 0, Math.PI * 2);
        ctx.fillStyle = midGlow;
        ctx.fill();

        const coreGrad = ctx.createRadialGradient(bx, by, 0, bx, by, 3);
        coreGrad.addColorStop(0, '#ffffff');
        coreGrad.addColorStop(0.5, isLocked ? '#aaffcc' : '#aaddff');
        coreGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.beginPath();
        ctx.arc(bx, by, 3, 0, Math.PI * 2);
        ctx.fillStyle = coreGrad;
        ctx.fill();

        const spikeLen = isLocked ? 18 : 12;
        const spikeAlpha = isLocked ? 0.55 : 0.35;
        ctx.strokeStyle = `rgba(200,230,255,${spikeAlpha})`;
        ctx.lineWidth = 0.8;
        [0, 90, 45, 135].forEach(angle => {
          const rad = (angle * Math.PI) / 180;
          ctx.beginPath();
          ctx.moveTo(bx + Math.cos(rad) * 2, by + Math.sin(rad) * 2);
          ctx.lineTo(bx + Math.cos(rad) * spikeLen, by + Math.sin(rad) * spikeLen);
          ctx.moveTo(bx - Math.cos(rad) * 2, by - Math.sin(rad) * 2);
          ctx.lineTo(bx - Math.cos(rad) * spikeLen, by - Math.sin(rad) * spikeLen);
          ctx.stroke();
        });
      }
    }

    // ── 4b. Secondary Targets (Multi-Target Mode) ───────────
    const secondaryTargets = (frame?.targets ?? []).filter(t => !t.is_primary && t.image_position);
    secondaryTargets.forEach(st => {
      const sx = st.image_position!.x;
      const sy = st.image_position!.y;
      if (sx > 0 && sx < W && sy > 0 && sy < H) {
        // Amber halo
        const sHalo = ctx.createRadialGradient(sx, sy, 0, sx, sy, 18);
        sHalo.addColorStop(0, 'rgba(230,160,50,0.35)');
        sHalo.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.beginPath();
        ctx.arc(sx, sy, 18, 0, Math.PI * 2);
        ctx.fillStyle = sHalo;
        ctx.fill();

        // Secondary beacon core (amber)
        ctx.fillStyle = '#ffdd88';
        if (beaconShape === 'square') {
          ctx.fillRect(sx - 4, sy - 4, 8, 8);
        } else {
          ctx.beginPath();
          ctx.arc(sx, sy, 4, 0, Math.PI * 2);
          ctx.fill();
        }

        // Secondary target ID label
        ctx.fillStyle = '#e39a32';
        ctx.font = 'bold 9px "Courier New", monospace';
        ctx.fillText(`${st.id} [SEC]`, sx + 10, sy - 6);

        // Dashed bracket box
        ctx.strokeStyle = 'rgba(230,160,50,0.75)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.strokeRect(sx - 9, sy - 9, 18, 18);
        ctx.setLineDash([]);
      }
    });

    // ── 5. Atmospheric visual effects ──────────────────────
    if (atmosMode !== 'clear') {
      const elapsed = frame?.elapsed ?? 0;

      if (atmosMode === 'haze') {
        // Haze: semi-transparent white overlay reducing contrast
        ctx.fillStyle = 'rgba(220,230,225,0.25)';
        ctx.fillRect(0, 0, W, H);
        // Slight brightness boost to simulate light scatter
        ctx.fillStyle = 'rgba(200,210,200,0.08)';
        ctx.fillRect(0, 0, W, H);

      } else if (atmosMode === 'fog') {
        // Fog: strong white overlay with animated wisps
        ctx.fillStyle = 'rgba(230,235,230,0.55)';
        ctx.fillRect(0, 0, W, H);
        // Animated fog tendrils
        for (let fi = 0; fi < 5; fi++) {
          const fx = (fi * 137 + elapsed * 15) % W;
          const fy = (fi * 89  + elapsed * 8)  % H;
          const fr2 = 60 + fi * 20;
          const fogGrad = ctx.createRadialGradient(fx, fy, 0, fx, fy, fr2);
          fogGrad.addColorStop(0, 'rgba(240,245,240,0.35)');
          fogGrad.addColorStop(1, 'rgba(240,245,240,0)');
          ctx.beginPath();
          ctx.ellipse(fx, fy, fr2 * 1.6, fr2, Math.sin(elapsed + fi) * 0.3, 0, Math.PI * 2);
          ctx.fillStyle = fogGrad;
          ctx.fill();
        }

      } else if (atmosMode === 'rain') {
        // Rain: diagonal streaks
        ctx.strokeStyle = 'rgba(180,200,220,0.35)';
        ctx.lineWidth = 0.8;
        const rainSpeed = elapsed * 300;
        for (let ri = 0; ri < 80; ri++) {
          const rx = ((ri * 67 + rainSpeed * 0.7) % (W + 40)) - 20;
          const ry = ((ri * 43 + rainSpeed) % (H + 30)) - 15;
          ctx.beginPath();
          ctx.moveTo(rx, ry);
          ctx.lineTo(rx - 4, ry + 14);
          ctx.stroke();
        }
        // Slight blur overlay
        ctx.fillStyle = 'rgba(160,180,200,0.06)';
        ctx.fillRect(0, 0, W, H);

      } else if (atmosMode === 'low_light') {
        // Low light: strong dark overlay + brightness reduction
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(0, 0, W, H);
        // Add slight green tint (night vision simulation)
        ctx.fillStyle = 'rgba(0,40,20,0.12)';
        ctx.fillRect(0, 0, W, H);
      }
    }

    // ── 5b. Atmospheric turbulence shimmer ───────────────────
    const turbEnabled = frame?.disturbance?.config?.atmospheric_turbulence?.enabled;
    if (turbEnabled && bx > 0 && bx < W && by > 0 && by < H) {
      const t = (frame?.elapsed ?? 0) * 8;
      const shimmerR = 16 + 6 * Math.sin(t * 2.3);
      ctx.strokeStyle = `rgba(150,200,255,${0.12 + 0.08 * Math.sin(t)})`;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.arc(bx + Math.sin(t * 1.7) * 3, by + Math.cos(t * 2.1) * 2, shimmerR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── 6. Detection bounding box ────────────────────────────
    const det = frame?.detection;
    if (det) {
      const dbx = det.bounding_box.x;
      const dby = det.bounding_box.y;
      const dbw = det.bounding_box.width;
      const dbh = det.bounding_box.height;
      const conf = det.confidence;

      // Filled semi-transparent box
      ctx.fillStyle = `rgba(62,207,207,${conf * 0.06})`;
      ctx.fillRect(dbx, dby, dbw, dbh);

      // Box outline
      ctx.strokeStyle = `rgba(95,179,192,${Math.max(0.4, conf)})`;
      ctx.lineWidth = 1;
      ctx.strokeRect(dbx, dby, dbw, dbh);

      // Corner brackets
      const cs = 10;
      ctx.strokeStyle = stateColor;
      ctx.lineWidth = 2;
      [[dbx, dby, 1, 1], [dbx+dbw, dby, -1, 1], [dbx, dby+dbh, 1, -1], [dbx+dbw, dby+dbh, -1, -1]].forEach(([x, y, sx, sy]) => {
        ctx.beginPath();
        ctx.moveTo(x as number, (y as number) + (sy as number) * cs);
        ctx.lineTo(x as number, y as number);
        ctx.lineTo((x as number) + (sx as number) * cs, y as number);
        ctx.stroke();
      });

      // Centroid dot
      ctx.beginPath();
      ctx.arc(det.centroid.x, det.centroid.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = stateColor;
      ctx.fill();

      // Confidence badge
      ctx.fillStyle = 'rgba(8,20,18,0.85)';
      const badgeW = 52;
      ctx.fillRect(dbx, dby - 17, badgeW, 14);
      ctx.fillStyle = `rgba(95,179,192,${conf})`;
      ctx.font = 'bold 9px "Courier New", monospace';
      ctx.fillText(`${(conf * 100).toFixed(1)}%`, dbx + 4, dby - 6);
    }

    // ── 7. Kalman predicted position ─────────────────────────
    const kal = frame?.kalman;
    if (kal?.predicted_position) {
      const kx = kal.predicted_position.x;
      const ky = kal.predicted_position.y;
      if (kx > 4 && kx < W - 4 && ky > 4 && ky < H - 4) {
        ctx.strokeStyle = 'rgba(224,160,64,0.75)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(kx, ky, 14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(kx - 5, ky); ctx.lineTo(kx + 5, ky);
        ctx.moveTo(kx, ky - 5); ctx.lineTo(kx, ky + 5);
        ctx.strokeStyle = 'rgba(224,160,64,0.9)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Velocity vector from Kalman
        if (kal.velocity && det) {
          const vscale = 0.4;
          const vx = (kal.velocity as {x:number;y:number}).x * vscale;
          const vy = (kal.velocity as {x:number;y:number}).y * vscale;
          if (Math.abs(vx) + Math.abs(vy) > 1) {
            ctx.strokeStyle = 'rgba(224,160,64,0.5)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(kx, ky);
            ctx.lineTo(kx + vx * 6, ky + vy * 6);
            ctx.stroke();
          }
        }
      }
    }

    // ── 8. Pan/tilt tracking reticle (camera centre) ─────────
    const errMag = frame ? Math.min((frame.angular_error?.total_error ?? 0) / 20, 1) : 0;
    const reticleColor = errMag > 0.4
      ? `rgba(192,80,80,0.7)` : errMag > 0.15
      ? `rgba(224,160,64,0.7)` : `rgba(62,207,207,0.6)`;

    // Outer circle
    ctx.strokeStyle = reticleColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(CX, CY, 32, 0, Math.PI * 2);
    ctx.stroke();

    // Inner circle
    ctx.beginPath();
    ctx.arc(CX, CY, 8, 0, Math.PI * 2);
    ctx.stroke();

    // Cross hairs (four segments with gap)
    ctx.lineWidth = 1;
    [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dx, dy]) => {
      ctx.beginPath();
      ctx.moveTo(CX + (dx as number)*12, CY + (dy as number)*12);
      ctx.lineTo(CX + (dx as number)*44, CY + (dy as number)*44);
      ctx.stroke();
    });

    // Centre dot
    ctx.beginPath();
    ctx.arc(CX, CY, 2, 0, Math.PI * 2);
    ctx.fillStyle = reticleColor;
    ctx.fill();

    // Angular error arc around reticle
    if (errMag > 0.01) {
      const arcColor = errMag > 0.4 ? '#a86a5a' : errMag > 0.15 ? '#e39a32' : '#8fa98f';
      ctx.strokeStyle = arcColor + 'aa';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(CX, CY, 40, -Math.PI / 2, -Math.PI / 2 + errMag * Math.PI * 2);
      ctx.stroke();
    }

    // ── 9. Scanline overlay (pre-rendered offscreen canvas — single blit) ──
    ctx.drawImage(getScanlineCanvas(W, H), 0, 0);

    // ── 10. HUD overlays ─────────────────────────────────────
    const hudFont    = '10px "Courier New", monospace';
    const hudFontSm  = '9px "Courier New", monospace';
    const hudFontB   = 'bold 11px "Courier New", monospace';

    // TOP-LEFT — target state
    ctx.fillStyle = 'rgba(4,12,10,0.82)';
    ctx.fillRect(8, 8, 196, frame?.detection ? 64 : 22);
    ctx.fillStyle = stateColor;
    ctx.font = hudFontB;
    ctx.fillText(`● ${state}`, 14, 23);
    // The video path's validation data is deliberately shown from the same
    // telemetry values that drove Kalman/PID, not from a synthetic target.
    if (frame?.detection) {
      const c = frame.detection.centroid;
      const e = frame.pixel_error;
      ctx.font = hudFontSm;
      ctx.fillStyle = '#8a9ba0';
      ctx.fillText(`CENTROID  X:${c.x.toFixed(1)}  Y:${c.y.toFixed(1)}`, 14, 37);
      ctx.fillText('IMG CTR   X:320.0  Y:240.0', 14, 49);
      ctx.fillStyle = '#9fd8e8';
      const ex = e?.x != null ? e.x.toFixed(1) : '—';
      const ey = e?.y != null ? e.y.toFixed(1) : '—';
      ctx.fillText(`ERROR     X:${ex}  Y:${ey} px`, 14, 61);
    }

    // TOP-RIGHT — mission ID
    ctx.fillStyle = 'rgba(4,12,10,0.82)';
    ctx.fillRect(W - 136, 8, 128, 22);
    ctx.fillStyle = 'rgba(62,207,207,0.7)';
    ctx.font = hudFont;
    ctx.textAlign = 'right';
    ctx.fillText('FSOC-DEMO-042', W - 12, 23);
    ctx.textAlign = 'left';

    // BOTTOM-LEFT — FPS + detector
    const fps = frame?.metrics?.fps?.toFixed(1) ?? '—';
    const det_model = frame?.detection?.detector?.toUpperCase() ?? 'NO DETECT';
    ctx.fillStyle = 'rgba(4,12,10,0.82)';
    ctx.fillRect(8, H - 38, 130, 30);
    ctx.fillStyle = '#8a9ba0';
    ctx.font = hudFont;
    ctx.fillText(`${fps} FPS`, 14, H - 24);
    ctx.font = hudFontSm;
    ctx.fillText(det_model, 14, H - 12);

    // BOTTOM-RIGHT — angular + pixel error
    if (frame) {
      const pe = frame.angular_error?.pan_error?.toFixed(3) ?? '—';
      const te = frame.angular_error?.tilt_error?.toFixed(3) ?? '—';
      const tot = frame.angular_error?.total_error?.toFixed(3) ?? '—';
      const pxe = frame.pixel_error;
      ctx.fillStyle = 'rgba(4,12,10,0.82)';
      ctx.fillRect(W - 148, H - 64, 140, 56);
      ctx.fillStyle = '#8a9ba0';
      ctx.font = hudFontSm;
      ctx.textAlign = 'right';
      ctx.fillText(`PAN   ${pe}°`, W - 12, H - 50);
      ctx.fillText(`TILT  ${te}°`, W - 12, H - 38);
      const pxTxt = pxe?.total != null ? `${pxe.total.toFixed(1)}px` : '—';
      const pxClr = pxe?.total != null && pxe.total <= 10 ? '#8fa98f'
        : pxe?.total != null && pxe.total <= 40 ? '#e39a32' : '#a86a5a';
      ctx.fillStyle = pxClr;
      ctx.fillText(`PX ERR  ${pxTxt}`, W - 12, H - 24);
      const errClr = parseFloat(tot) > 2 ? '#a86a5a' : parseFloat(tot) > 0.5 ? '#e39a32' : '#8fa98f';
      ctx.fillStyle = errClr;
      ctx.font = hudFont;
      ctx.fillText(`ERR  ${tot}°`, W - 12, H - 10);
      ctx.textAlign = 'left';
    }

    // TOP-CENTER — elapsed + frame
    if (frame) {
      const elapsed = frame.elapsed?.toFixed(1) ?? '0.0';
      const fid = frame.frame_id ?? 0;
      ctx.fillStyle = 'rgba(4,12,10,0.75)';
      ctx.fillRect(CX - 64, 8, 128, 22);
      ctx.fillStyle = 'rgba(140,160,160,0.8)';
      ctx.font = hudFontSm;
      ctx.textAlign = 'center';
      ctx.fillText(`T+${elapsed}s  F:${fid}`, CX, 23);
      ctx.textAlign = 'left';
    }

    // FOV border vignette
    const vign = ctx.createRadialGradient(CX, CY, Math.min(W,H)*0.35, CX, CY, Math.min(W,H)*0.72);
    vign.addColorStop(0, 'rgba(0,0,0,0)');
    vign.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vign;
    ctx.fillRect(0, 0, W, H);

    // Frame border
    ctx.strokeStyle = 'rgba(62,207,207,0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(2, 2, W-4, H-4);

  }, [frame, atmosMode, noiseMode, beaconShape, beaconSize]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="camera-feed-canvas"
      aria-label="Synthetic camera feed"
    />
  );
}
