/**
 * FSOC — Camera Feed (Clean Decluttered View)
 * Displays the fixed sensor video feed with minimal, high-value overlays:
 *   1. Fixed Optical Center reticle (never moves)
 *   2. Detected Beacon marker
 *   3. Movable FSOC Camera FOV rectangle
 *   4. Single thin Error Vector
 *   5. Single Status Badge (in-canvas — the one indicator for 2D view)
 *   6. Optional Debug Mode candidate boxes
 */
import React, { useRef, useEffect, useState } from 'react';
import type { TelemetryFrame, TargetState } from '../../types/fsoc';

const STATE_COLOR: Record<TargetState, string> = {
  READY: '#8a9ba0',
  SEARCHING: '#faad14',
  DETECTED: '#fadb14',
  ACQUIRING: '#faad14',
  TRACKING: '#52c41a',
  LOCKED: '#52c41a',
  LOST: '#ff4d4f',
  REACQUIRING: '#fa8c16',
  ERROR: '#ff4d4f',
};

interface Props {
  frame: TelemetryFrame | null;
  width?: number;
  height?: number;
  atmosMode?: 'clear' | 'haze' | 'fog' | 'rain' | 'low_light';
  noiseMode?: 'gaussian' | 'salt_pepper' | 'poisson' | 'none';
  beaconShape?: 'square' | 'circle';
  beaconSize?: number;
  onVideoFrameRendered?: (frame: TelemetryFrame | null) => void;
  videoUploadPending?: boolean;
  debugMode?: boolean;
}

export function CameraFeed({
  frame,
  width = 640,
  height = 480,
  atmosMode = 'clear',
  noiseMode = 'gaussian',
  beaconShape = 'square',
  beaconSize = 10,
  onVideoFrameRendered,
  videoUploadPending = false,
  debugMode = false,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderedVideo, setRenderedVideo] = useState<{
    sessionId: string;
    frameIndex: number;
    frame: TelemetryFrame;
    image: HTMLImageElement;
  } | null>(null);

  const newestSession = useRef<string | null>(null);
  const renderedIndex = useRef(-1);
  // Single reused JPEG decoder: one Image element for the whole session.
  // Per-frame `new Image()` caused GC churn + queued stale decodes at 30
  // fps; reusing cancels the in-flight decode so we always show latest.
  const decoderRef = useRef<HTMLImageElement | null>(null);
  const pendingRef = useRef<{
    sessionId: string;
    frameIndex: number;
    frame: TelemetryFrame;
    jpeg: string;
  } | null>(null);

  // Sync uploaded video frames
  useEffect(() => {
    if (frame?.source !== 'video_input') {
      newestSession.current = null;
      renderedIndex.current = -1;
      pendingRef.current = null;
      setRenderedVideo(null);
      return;
    }
    const sessionId = frame.session_id ?? 'unidentified-video-session';
    if (newestSession.current !== sessionId) {
      newestSession.current = sessionId;
      renderedIndex.current = -1;
      pendingRef.current = null;
      setRenderedVideo(null);
    }
    const frameIndex = frame.frame_index ?? frame.frame_id ?? -1;
    if (!frame.video_frame_jpeg || frameIndex < 0) return;
    if (frameIndex < renderedIndex.current) return;

    if (!decoderRef.current) {
      const img = new Image();
      img.onload = () => {
        const p = pendingRef.current;
        if (!p || newestSession.current !== p.sessionId || p.frameIndex < renderedIndex.current) return;
        renderedIndex.current = p.frameIndex;
        pendingRef.current = null;
        setRenderedVideo({ sessionId: p.sessionId, frameIndex: p.frameIndex, frame: p.frame, image: img });
      };
      decoderRef.current = img;
    }
    pendingRef.current = { sessionId, frameIndex, frame, jpeg: frame.video_frame_jpeg };
    decoderRef.current.src = `data:image/jpeg;base64,${frame.video_frame_jpeg}`;
  }, [frame]);

  useEffect(() => {
    onVideoFrameRendered?.(renderedVideo?.frame ?? null);
  }, [renderedVideo, onVideoFrameRendered]);

  // Main Canvas Render
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const CX = W / 2; // 320 px (Fixed Optical Center)
    const CY = H / 2; // 240 px (Fixed Optical Center)

    const isVideoMode = frame?.source === 'video_input' || videoUploadPending;
    const displayFrame = isVideoMode ? renderedVideo?.frame ?? null : frame;
    const state = (displayFrame?.target_state ?? 'READY') as TargetState;
    const stateColor = STATE_COLOR[state] ?? '#8a9ba0';
    const isLocked = state === 'LOCKED' || state === 'TRACKING';
    const videoReady = isVideoMode && !!renderedVideo?.image?.naturalWidth;

    // ── 1. Base Image Display ──────────────────────────────────
    if (isVideoMode && videoReady && renderedVideo?.image) {
      // Stationary video frame: never moved, panned, or scaled
      ctx.drawImage(renderedVideo.image, 0, 0, W, H);
    } else if (isVideoMode) {
      // Loading placeholder
      ctx.fillStyle = '#0a0d10';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#faad14';
      ctx.font = '600 13px ui-monospace, monospace';
      ctx.textAlign = 'center';
      const statusText =
        frame?.video_status === 'VIDEO_ERROR'
          ? 'VIDEO DECODING ERROR'
          : videoUploadPending
          ? 'UPLOADING MP4 SENSOR FEED…'
          : frame?.video_status === 'VIDEO_LOADING'
          ? 'INITIALIZING MP4 DECODER…'
          : 'WAITING FOR VIDEO FRAME…';
      ctx.fillText(statusText, CX, CY - 10);
      ctx.fillStyle = '#5c6b73';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText('RESOLUTION: 640×480 · 30 FPS', CX, CY + 14);
      ctx.textAlign = 'left';
    } else {
      // Virtual mode background
      ctx.fillStyle = '#080a0c';
      ctx.fillRect(0, 0, W, H);
      // Subtle horizon
      const horizGrad = ctx.createLinearGradient(0, H * 0.65, 0, H);
      horizGrad.addColorStop(0, 'rgba(0,0,0,0)');
      horizGrad.addColorStop(1, 'rgba(40,60,80,0.12)');
      ctx.fillStyle = horizGrad;
      ctx.fillRect(0, H * 0.65, W, H * 0.35);
    }

    // ── 2. Fixed Optical-Center Reticle (NEVER MOVES) ──────────
    ctx.save();
    ctx.strokeStyle = 'rgba(180, 205, 220, 0.45)';
    ctx.lineWidth = 1;
    // Four small cross arms with a 6px center gap
    const armLen = 14;
    const gap = 3;
    ctx.beginPath();
    ctx.moveTo(CX - armLen, CY); ctx.lineTo(CX - gap, CY);
    ctx.moveTo(CX + gap, CY);   ctx.lineTo(CX + armLen, CY);
    ctx.moveTo(CX, CY - armLen); ctx.lineTo(CX, CY - gap);
    ctx.moveTo(CX, CY + gap);   ctx.lineTo(CX, CY + armLen);
    ctx.stroke();

    // Center dot
    ctx.beginPath();
    ctx.arc(CX, CY, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(210, 230, 245, 0.8)';
    ctx.fill();

    // Small unobtrusive label
    ctx.font = '8px "Courier New", monospace';
    ctx.fillStyle = 'rgba(180, 205, 220, 0.45)';
    ctx.textAlign = 'center';
    ctx.fillText('OPTICAL CENTER', CX, CY + 22);
    ctx.restore();

    // ── 3. Beacon Marker (Detector's Actual Location) ─────────
    const det = displayFrame?.detection;
    const hasDet = !!(det && Number.isFinite(det.centroid?.x) && Number.isFinite(det.centroid?.y));
    const bx = hasDet ? det.centroid.x : 0;
    const by = hasDet ? det.centroid.y : 0;

    if (hasDet && bx > 0 && bx < W && by > 0 && by < H) {
      ctx.save();
      const bColor = isLocked ? '#52c41a' : '#faad14';
      ctx.strokeStyle = bColor;
      ctx.lineWidth = 1.4;

      // Beacon marker — honors shape/size settings so it stays distinct
      // from the (always rectangular) FSOC FOV box.
      const sz = beaconSize;
      if (beaconShape === 'circle') {
        ctx.beginPath();
        ctx.arc(bx, by, sz / 2, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.strokeRect(bx - sz / 2, by - sz / 2, sz, sz);
      }

      // Centroid center dot
      ctx.beginPath();
      ctx.arc(bx, by, 2, 0, Math.PI * 2);
      ctx.fillStyle = bColor;
      ctx.fill();

      // Clean label
      ctx.font = 'bold 9px "Courier New", monospace';
      ctx.fillStyle = bColor;
      ctx.textAlign = 'center';
      ctx.fillText('BEACON', bx, by - sz / 2 - 4);
      ctx.restore();
    }

    // ── 4. Current FSOC Camera FOV (MOVES WITH PAN/TILT) ───────
    const camAim = displayFrame?.camera_center ?? { x: CX, y: CY };
    const fovW = 160; // 1° at 640px sensor width
    const fovH = 120; // 0.75° at 480px sensor height
    const left = camAim.x - fovW / 2;
    const top = camAim.y - fovH / 2;

    ctx.save();
    const fovColor = isLocked ? 'rgba(82, 196, 26, 0.85)' : 'rgba(95, 179, 192, 0.85)';
    ctx.strokeStyle = fovColor;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(left, top, fovW, fovH);

    // Camera aim reticle at camera center
    ctx.beginPath();
    ctx.moveTo(camAim.x - 7, camAim.y); ctx.lineTo(camAim.x + 7, camAim.y);
    ctx.moveTo(camAim.x, camAim.y - 7); ctx.lineTo(camAim.x, camAim.y + 7);
    ctx.stroke();

    // Camera FOV label
    ctx.font = '9px "Courier New", monospace';
    ctx.fillStyle = fovColor;
    ctx.textAlign = 'left';
    ctx.fillText('FSOC FOV', left + 4, top - 4);
    ctx.restore();

    // ── 5. Error Vector (Line from Camera Center to Beacon) ────
    if (hasDet && (Math.abs(camAim.x - bx) > 1 || Math.abs(camAim.y - by) > 1)) {
      ctx.save();
      ctx.strokeStyle = isLocked ? 'rgba(82, 196, 26, 0.65)' : 'rgba(250, 173, 20, 0.75)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(camAim.x, camAim.y);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.restore();
    }

    // ── 6. Top Status Badge (Single Prominent Indicator) ───────
    ctx.save();
    ctx.font = 'bold 11px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = stateColor;
    ctx.fillText(`● ${state}`, W - 14, 22);
    ctx.restore();

    // ── 7. Optional Debug Mode: Candidate Visualization ────────
    if (debugMode && displayFrame?.candidates) {
      ctx.save();
      displayFrame.candidates.forEach(cand => {
        const isSel = cand.selected;
        ctx.strokeStyle = isSel ? '#52c41a' : 'rgba(180, 200, 220, 0.35)';
        ctx.lineWidth = isSel ? 1.5 : 0.8;
        if (!isSel) ctx.setLineDash([2, 2]);
        else ctx.setLineDash([]);
        ctx.strokeRect(cand.x, cand.y, cand.w, cand.h);

        ctx.font = '8px monospace';
        ctx.fillStyle = isSel ? '#52c41a' : 'rgba(180, 200, 220, 0.5)';
        ctx.textAlign = 'left';
        ctx.fillText(`s:${cand.score.toFixed(2)}`, cand.x, cand.y + cand.h + 8);
      });
      ctx.restore();
    }

    // Subtle outer border
    ctx.strokeStyle = 'rgba(95, 179, 192, 0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(1, 1, W - 2, H - 2);

  }, [frame, renderedVideo, debugMode, videoUploadPending, beaconShape, beaconSize]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="camera-feed-canvas"
      aria-label="FSOC Camera Tracking Feed"
    />
  );
}
