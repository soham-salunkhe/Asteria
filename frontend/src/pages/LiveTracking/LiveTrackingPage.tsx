/**
 * FSOC — Live Tracking Page (Clean Redesign)
 * Dominant video feed with minimal clutter and 4 focused telemetry cards.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useSimulation } from '../../hooks/useSimulation';
import { CameraFeed } from '../../components/simulation/CameraFeed';
import { SimulationViewport } from '../../components/simulation/SimulationViewport';
import { TelemetryPanel, TelemetryField } from '../../components/telemetry/TelemetryPanel';
import { TargetStateIndicator } from '../../components/telemetry/TargetStateIndicator';
import { EventLog } from '../../components/telemetry/EventLog';
import type { TargetState } from '../../types/fsoc';

type ViewMode = 'camera' | '3d';

export function LiveTrackingPage() {
  const sim = useSimulation();
  const [viewMode, setViewMode] = useState<ViewMode>('camera');
  const [starting, setStarting] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [eventLogOpen, setEventLogOpen] = useState(false);
  const [videoUploadPending, setVideoUploadPending] = useState(
    () => sessionStorage.getItem('asteria-video-upload-pending') === '1',
  );

  const [displayedVideoFrame, setDisplayedVideoFrame] = useState<typeof sim.latest>(null);
  const onVideoFrameRendered = useCallback((videoFrame: typeof sim.latest) => {
    setDisplayedVideoFrame(videoFrame);
  }, []);

  const incoming = sim.latest;
  useEffect(() => {
    if (incoming?.source === 'video_input') {
      setVideoUploadPending(false);
      sessionStorage.removeItem('asteria-video-upload-pending');
    }
  }, [incoming?.source]);

  const f = incoming?.source === 'video_input'
    ? (displayedVideoFrame?.session_id === incoming.session_id ? displayedVideoFrame : null)
    : incoming;

  const cam = f?.camera;
  const det = f?.detection;
  const kal = f?.kalman;
  const met = f?.metrics;
  const pid = f?.pid_output;
  const pxe = f?.pixel_error;
  const aim = f?.camera_center ?? { x: 320, y: 240 };
  const ps = met?.ps169;

  const totalFrames = f?.video_total_frames ?? 600;
  const currFrame = f?.frame_index ?? f?.frame_id ?? 0;
  const streamFps = f?.video_fps ?? met?.fps ?? 30.0;
  const elapsed = f?.elapsed ?? 0.0;
  const totalDuration = totalFrames > 0 && streamFps > 0 ? totalFrames / streamFps : 20.0;
  const progressPct = totalFrames > 0 ? Math.min(100, Math.max(0, (currFrame / totalFrames) * 100)) : 0;

  // Trend formatting
  const trend = f?.error_trend ?? 'STABLE';
  const trendLabel =
    trend === 'DECREASING' ? '↓ DECREASING' : trend === 'DIVERGING' ? '↑ DIVERGING' : '→ STABLE';

  const fmt = (v: number | undefined | null, dec = 2) =>
    v !== null && v !== undefined ? v.toFixed(dec) : null;

  // ── Card 1: TRACKING ───────────────────────────────────────
  const trackingFields: TelemetryField[] = [
    {
      label: 'STATUS',
      value: f?.target_state ?? 'READY',
      highlight: f?.target_state === 'LOCKED' || f?.target_state === 'TRACKING',
      warn: f?.target_state === 'LOST' || f?.target_state === 'ERROR',
    },
    {
      label: 'BEACON',
      value: det?.centroid ? `${det.centroid.x.toFixed(0)}, ${det.centroid.y.toFixed(0)} px` : '—',
    },
    {
      label: 'CAMERA',
      value: `${aim.x.toFixed(0)}, ${aim.y.toFixed(0)} px`,
    },
    {
      label: 'ERROR',
      value: pxe?.total != null ? `${pxe.total.toFixed(1)} px` : '—',
      highlight: pxe?.total != null && pxe.total <= 10,
      warn: pxe?.total != null && pxe.total > 20,
    },
    {
      label: 'CONF',
      value: det?.confidence != null ? det.confidence.toFixed(2) : '—',
      highlight: (det?.confidence ?? 0) > 0.8,
    },
    {
      label: 'TREND',
      value: trendLabel,
      highlight: trend === 'DECREASING',
      warn: trend === 'DIVERGING',
    },
  ];

  // ── Card 2: CONTROL ────────────────────────────────────────
  const controlFields: TelemetryField[] = [
    {
      label: 'PAN',
      value: cam?.pan != null ? `${cam.pan >= 0 ? '+' : ''}${cam.pan.toFixed(2)}°` : '—',
    },
    {
      label: 'TILT',
      value: cam?.tilt != null ? `${cam.tilt >= 0 ? '+' : ''}${cam.tilt.toFixed(2)}°` : '—',
    },
    {
      label: 'SETTLED',
      value: pid?.settled ? 'YES' : 'NO',
      highlight: pid?.settled,
    },
  ];

  // ── Card 3: PERFORMANCE ────────────────────────────────────
  const performanceFields: TelemetryField[] = [
    {
      label: 'ACQ',
      value: met?.acquisition_time != null ? `${met.acquisition_time.toFixed(2)} s` : '—',
      highlight: met?.acquisition_time != null && met.acquisition_time <= 2.0,
    },
    {
      label: 'AVG ERR',
      value: met?.average_error_px != null ? `${met.average_error_px.toFixed(1)} px` : '—',
      highlight: met?.average_error_px != null && met.average_error_px <= 10.0,
    },
    {
      label: 'MAX ERR',
      value: met?.max_error_px != null ? `${met.max_error_px.toFixed(1)} px` : '—',
      highlight: met?.max_error_px != null && met.max_error_px <= 10.0,
      warn: met?.max_error_px != null && met.max_error_px > 10.0,
    },
    {
      label: 'LOCK',
      value: met?.lock_retention != null ? `${met.lock_retention.toFixed(1)} %` : '—',
      highlight: (met?.lock_retention ?? 0) > 60,
    },
    {
      label: 'FPS',
      value: met?.fps != null ? `${met.fps.toFixed(0)}` : streamFps ? `${streamFps.toFixed(0)}` : '—',
      highlight: (met?.fps ?? streamFps) >= 20,
    },
  ];

  // ── Card 4: COMPLIANCE ─────────────────────────────────────
  const complianceFields: TelemetryField[] = [
    {
      label: 'ACQ ≤2s',
      value: ps?.acquisition_s?.value != null ? (ps.acquisition_s.pass ? 'PASS' : 'FAIL') : '—',
      highlight: ps?.acquisition_s?.pass,
      warn: ps?.acquisition_s?.pass === false && ps?.acquisition_s?.value != null,
    },
    {
      label: 'ERR ≤10px',
      value: ps?.avg_error_px?.value != null ? (ps.avg_error_px.pass ? 'PASS' : 'FAIL') : '—',
      highlight: ps?.avg_error_px?.pass,
      warn: ps?.avg_error_px?.pass === false && ps?.avg_error_px?.value != null,
    },
    {
      label: 'LOSS <5%',
      value: ps?.target_loss_pct?.value != null ? (ps.target_loss_pct.pass ? 'PASS' : 'FAIL') : '—',
      highlight: ps?.target_loss_pct?.pass,
      warn: ps?.target_loss_pct?.pass === false && ps?.target_loss_pct?.value != null,
    },
    {
      // Zero losses = no re-acq needed = PASS (shown as "—" meaning N/A)
      label: 'REACQ ≤1s',
      value: ps?.reacquisition_s != null
        ? (ps.reacquisition_s.value == null
            ? 'N/A'  // zero losses — trivially passes
            : ps.reacquisition_s.pass ? 'PASS' : `FAIL`)
        : '—',
      highlight: ps?.reacquisition_s?.pass ?? false,
      warn: ps?.reacquisition_s?.pass === false && ps?.reacquisition_s?.value != null,
    },
    {
      label: 'LOCK ≥95%',
      value: ps?.lock_retention?.value != null
        ? `${ps.lock_retention.value.toFixed(1)}% ${ps.lock_retention.pass ? '✓' : '✗'}`
        : (met?.lock_retention != null ? `${met.lock_retention.toFixed(1)}%` : '—'),
      highlight: ps?.lock_retention?.pass ?? (met?.lock_retention != null && met.lock_retention >= 95),
      warn: ps?.lock_retention?.pass === false && ps?.lock_retention?.value != null,
    },
    {
      label: 'FPS ≥20',
      value: ps?.fps?.value != null ? (ps.fps.pass ? 'PASS' : 'FAIL') : (streamFps >= 20 ? 'PASS' : 'FAIL'),
      highlight: (ps?.fps?.pass ?? streamFps >= 20),
    },
  ];

  return (
    <div className="page-tracking">
      {/* ── Main Center Viewport ───────────────────────────── */}
      <div className="tracking-viewport" style={{ display: 'flex', flexDirection: 'column' }}>

        {/* Compact Clean Video Top Bar */}
        <div
          className="viewport-toggle"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '6px 14px',
            background: '#090d10',
            borderBottom: '1px solid var(--border)',
            minHeight: '38px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: '11px', fontWeight: 600, color: 'var(--cyan)' }}>
              CAMERA FEED (2D)
            </span>
            <span style={{ color: 'var(--border)' }}>|</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: '10px', color: '#8fa0a8' }}>
              SOURCE: {f?.source === 'video_input' ? 'MP4' : 'VIRTUAL'}
            </span>
            <span style={{ color: 'var(--border)' }}>|</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: '10px', color: '#8fa0a8' }}>
              640×480
            </span>
            <span style={{ color: 'var(--border)' }}>|</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: '10px', color: '#8fa0a8' }}>
              {Math.round(streamFps)} FPS
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <TargetStateIndicator state={(f?.target_state as TargetState) ?? 'READY'} />

            <span style={{ color: 'var(--border)', margin: '0 4px' }}>|</span>

            <button
              className={`vp-btn vp-btn--sm${viewMode === 'camera' ? ' vp-btn--active' : ''}`}
              onClick={() => setViewMode('camera')}
            >
              2D
            </button>
            <button
              className={`vp-btn vp-btn--sm${viewMode === '3d' ? ' vp-btn--active' : ''}`}
              onClick={() => setViewMode('3d')}
            >
              3D
            </button>

            <button
              className={`vp-btn vp-btn--sm${debugMode ? ' vp-btn--active' : ''}`}
              onClick={() => setDebugMode(!debugMode)}
              title="Toggle Candidate Debug Overlays"
              style={{ marginLeft: '4px', borderColor: debugMode ? '#52c41a' : undefined }}
            >
              DEBUG
            </button>

            {!sim.latest && (
              <button
                className="vp-btn vp-btn--sm vp-btn--start"
                disabled={starting}
                onClick={async () => {
                  setStarting(true);
                  try { await sim.startDemo(); } finally { setStarting(false); }
                }}
              >
                {starting ? '…' : 'DEMO'}
              </button>
            )}
          </div>
        </div>

        {/* Video Canvas Viewport */}
        <div
          className="viewport-canvas"
          style={{
            flex: 1,
            position: 'relative',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            background: '#040709',
            overflow: 'hidden',
          }}
        >
          {viewMode === 'camera' ? (
            <CameraFeed
              frame={incoming}
              width={640}
              height={480}
              onVideoFrameRendered={onVideoFrameRendered}
              videoUploadPending={videoUploadPending}
              debugMode={debugMode}
            />
          ) : (
            <SimulationViewport frame={f} history={sim.history} />
          )}
        </div>

        {/* Compact Clean Bottom Video Bar */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            background: '#090d10',
            borderTop: '1px solid var(--border)',
            padding: '4px 14px 6px',
            gap: '3px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: '10px', color: '#8fa0a8' }}>
              FRAME {currFrame} / {totalFrames}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: '10px', color: '#8fa0a8' }}>
              {elapsed.toFixed(1)} / {totalDuration.toFixed(1)} s
            </span>
          </div>
          {/* Subtle Progress Bar */}
          <div style={{ width: '100%', height: '3px', background: 'rgba(255,255,255,0.08)', borderRadius: '2px', overflow: 'hidden' }}>
            <div
              style={{
                width: `${progressPct}%`,
                height: '100%',
                background: f?.target_state === 'LOCKED' ? '#52c41a' : 'var(--cyan)',
                // No CSS transition: width already steps every frame at
                // stream rate; transitioning re-interpolates 30×/s.
              }}
            />
          </div>
        </div>
      </div>

      {/* ── Right Sidebar: Four Clean Cards ───────────────── */}
      <div className="tracking-sidebar" style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px' }}>

        {/* CARD 1: TRACKING */}
        <TelemetryPanel
          title="TRACKING"
          fields={trackingFields}
        />

        {/* CARD 2: CONTROL */}
        <TelemetryPanel
          title="CONTROL"
          fields={controlFields}
        />

        {/* CARD 3: PERFORMANCE */}
        <TelemetryPanel
          title="PERFORMANCE"
          fields={performanceFields}
        />

        {/* CARD 4: COMPLIANCE */}
        <TelemetryPanel
          title="COMPLIANCE"
          fields={complianceFields}
        />

        {/* Collapsible EVENT LOG */}
        <div style={{ marginTop: '4px', borderTop: '1px solid var(--border)', paddingTop: '6px' }}>
          <button
            onClick={() => setEventLogOpen(!eventLogOpen)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-3)',
              fontFamily: 'var(--mono)',
              fontSize: '10px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              padding: '4px 6px',
            }}
          >
            <span>EVENT LOG</span>
            <span>{eventLogOpen ? '▼' : '▶'}</span>
          </button>
          {eventLogOpen && (
            <div style={{ marginTop: '4px' }}>
              <EventLog events={sim.events} maxHeight={150} />
            </div>
          )}
        </div>

        {/* Temporary DEBUG Panel (When enabled) */}
        {debugMode && (
          <div style={{ marginTop: '6px', borderTop: '1px dashed var(--cyan)', paddingTop: '6px' }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: '9px', color: 'var(--cyan)', marginBottom: '4px' }}>
              DEBUG TRACKING
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: '9px', color: '#8fa0a8', lineHeight: '1.4' }}>
              <div>FRAME: {currFrame}</div>
              <div>CANDIDATES: {f?.candidates?.length ?? 0}</div>
              <div>CONFIDENCE: {det?.confidence?.toFixed(3) ?? '—'}</div>
              <div>PRED POS: {kal?.predicted_position ? `${kal.predicted_position.x.toFixed(1)}, ${kal.predicted_position.y.toFixed(1)}` : '—'}</div>
              <div>CAMERA CTR: {aim.x.toFixed(1)}, {aim.y.toFixed(1)}</div>
              <div>PID PAN: {pid?.pan_correction?.toFixed(4) ?? '0'}°</div>
              <div>PID TILT: {pid?.tilt_correction?.toFixed(4) ?? '0'}°</div>
              <div>STATE: {f?.target_state ?? '—'}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
