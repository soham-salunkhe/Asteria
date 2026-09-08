/**
 * FSOC — Live Tracking Page
 * The hero screen. ~70% viewport = simulation, remainder = telemetry.
 */
import React, { useState } from 'react';
import { useSimulation } from '../../hooks/useSimulation';
import { CameraFeed } from '../../components/simulation/CameraFeed';
import { SimulationViewport } from '../../components/simulation/SimulationViewport';
import { TelemetryPanel } from '../../components/telemetry/TelemetryPanel';
import { TargetStateIndicator } from '../../components/telemetry/TargetStateIndicator';
import { EventLog } from '../../components/telemetry/EventLog';
import type { TargetState } from '../../types/fsoc';

type ViewMode  = 'camera' | '3d';
type AtmosMode = 'clear' | 'haze' | 'fog' | 'rain' | 'low_light';
type NoiseMode = 'gaussian' | 'salt_pepper' | 'poisson' | 'none';

export function LiveTrackingPage() {
  const sim = useSimulation();
  const [viewMode,   setViewMode]   = useState<ViewMode>('camera');
  const [starting,   setStarting]   = useState(false);
  const [atmosMode,  setAtmosMode]  = useState<AtmosMode>('clear');
  const [noiseMode,  setNoiseMode]  = useState<NoiseMode>('gaussian');

  const f = sim.latest;
  const cam   = f?.camera;
  const tgt   = f?.target;
  const err   = f?.angular_error;
  const det   = f?.detection;
  const kal   = f?.kalman;
  const met   = f?.metrics;
  const pid   = f?.pid_output;
  const dis   = f?.disturbance;

  const fmt = (v: number | undefined | null, dec = 2) =>
    v !== null && v !== undefined ? v.toFixed(dec) : '—';

  return (
    <div className="page-tracking">
      {/* ── Hero viewport ─────────────────────────────────── */}
      <div className="tracking-viewport">

        {/* View toggle + atmosphere/noise controls */}
        <div className="viewport-toggle">
          {!sim.latest && (
            <button
              className="vp-btn vp-btn--start"
              disabled={starting}
              onClick={async () => {
                setStarting(true);
                try { await sim.startDemo(); } finally { setStarting(false); }
              }}
            >
              {starting ? 'STARTING…' : 'START DEMO'}
            </button>
          )}
          <button
            className={`vp-btn${viewMode === 'camera' ? ' vp-btn--active' : ''}`}
            onClick={() => setViewMode('camera')}
          >
            Camera Feed (2D)
          </button>
          <button
            className={`vp-btn${viewMode === '3d' ? ' vp-btn--active' : ''}`}
            onClick={() => setViewMode('3d')}
          >
            3-D View
          </button>

          {/* Atmospheric mode selector */}
          <span className="vp-sep" />
          {(['clear','haze','fog','rain','low_light'] as AtmosMode[]).map(m => (
            <button
              key={m}
              className={`vp-btn vp-btn--sm${atmosMode === m ? ' vp-btn--active' : ''}`}
              onClick={() => setAtmosMode(m)}
              title={`Atmospheric: ${m}`}
            >
              {m === 'clear' ? '☀' : m === 'haze' ? '🌫' : m === 'fog' ? '🌁' : m === 'rain' ? '🌧' : '🌑'}
            </button>
          ))}

          {/* Noise mode selector */}
          <span className="vp-sep" />
          {([['G','gaussian'],['S','salt_pepper'],['P','poisson'],['✕','none']] as [string, NoiseMode][]).map(([label, mode]) => (
            <button
              key={mode}
              className={`vp-btn vp-btn--sm${noiseMode === mode ? ' vp-btn--active' : ''}`}
              onClick={() => setNoiseMode(mode)}
              title={`Noise: ${mode}`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* State overlay */}
        <div className="viewport-state-overlay">
          <TargetStateIndicator state={(sim.targetState as TargetState) ?? 'READY'} large />
        </div>

        {/* Viewport */}
        <div className="viewport-canvas">
          {viewMode === 'camera' ? (
            <CameraFeed frame={f} width={640} height={480} atmosMode={atmosMode} noiseMode={noiseMode} />
          ) : (
            <SimulationViewport frame={f} history={sim.history} />
          )}
        </div>

        {/* Bottom status strip */}
        <div className="viewport-strip">
          <div className="vstrip-item">
            <span className="vstrip-label">MISSION</span>
            <span className="vstrip-val">FSOC-DEMO-042</span>
          </div>
          <div className="vstrip-sep" />
          <div className="vstrip-item">
            <span className="vstrip-label">ELAPSED</span>
            <span className="vstrip-val">{fmt(f?.elapsed, 1)} s</span>
          </div>
          <div className="vstrip-sep" />
          <div className="vstrip-item">
            <span className="vstrip-label">FRAME</span>
            <span className="vstrip-val">{f?.frame_id ?? '—'}</span>
          </div>
          <div className="vstrip-sep" />
          <div className="vstrip-item">
            <span className="vstrip-label">FPS</span>
            <span className="vstrip-val">{fmt(met?.fps, 1)}</span>
          </div>
          <div className="vstrip-sep" />
          <div className="vstrip-item">
            <span className="vstrip-label">PROC</span>
            <span className="vstrip-val">{fmt(met?.processing_ms, 1)} ms</span>
          </div>
        </div>
      </div>

      {/* ── Right sidebar ─────────────────────────────────── */}
      <div className="tracking-sidebar">

        {/* Camera state */}
        <TelemetryPanel
          title="CAMERA STATE"
          fields={[
            { label: 'PAN',       value: fmt(cam?.pan),       unit: '°' },
            { label: 'TILT',      value: fmt(cam?.tilt),      unit: '°' },
            { label: 'PAN RATE',  value: fmt(cam?.pan_rate),  unit: '°/s' },
            { label: 'TILT RATE', value: fmt(cam?.tilt_rate), unit: '°/s' },
          ]}
          columns={2}
        />

        <div className="sidebar-divider" />

        {/* Target state */}
        <TelemetryPanel
          title="TARGET TELEMETRY"
          fields={[
            { label: 'POS X', value: fmt(tgt?.position.x, 1), unit: 'm' },
            { label: 'POS Y', value: fmt(tgt?.position.y, 1), unit: 'm' },
            { label: 'POS Z', value: fmt(tgt?.position.z, 1), unit: 'm' },
            { label: 'VEL X', value: fmt(tgt?.velocity.x, 2), unit: 'm/s' },
            { label: 'VEL Y', value: fmt(tgt?.velocity.y, 2), unit: 'm/s' },
            { label: 'IMG X', value: fmt(tgt?.image_position?.x, 1), unit: 'px' },
            { label: 'IMG Y', value: fmt(tgt?.image_position?.y, 1), unit: 'px' },
          ]}
          columns={2}
        />

        <div className="sidebar-divider" />

        {/* Angular error */}
        <TelemetryPanel
          title="ANGULAR ERROR"
          fields={[
            {
              label: 'PAN ERROR',
              value: fmt(err?.pan_error),
              unit: '°',
              warn: Math.abs(err?.pan_error ?? 0) > 2,
            },
            {
              label: 'TILT ERROR',
              value: fmt(err?.tilt_error),
              unit: '°',
              warn: Math.abs(err?.tilt_error ?? 0) > 2,
            },
            {
              label: 'TOTAL ERROR',
              value: fmt(err?.total_error),
              unit: '°',
              highlight: (err?.total_error ?? 0) < 0.5,
              warn: (err?.total_error ?? 0) > 2,
            },
          ]}
        />

        <div className="sidebar-divider" />

        {/* Detection */}
        <TelemetryPanel
          title="DETECTION"
          fields={[
            { label: 'CONFIDENCE',   value: det ? `${(det.confidence * 100).toFixed(1)}%` : '—', highlight: (det?.confidence ?? 0) > 0.9 },
            { label: 'MODEL',        value: det?.detector?.toUpperCase() ?? '—', dim: true },
            { label: 'INFERENCE',    value: fmt(det?.inference_ms, 1),  unit: 'ms' },
            { label: 'CENTROID X',   value: fmt(det?.centroid.x, 1),  unit: 'px' },
            { label: 'CENTROID Y',   value: fmt(det?.centroid.y, 1),  unit: 'px' },
          ]}
        />

        <div className="sidebar-divider" />

        {/* Kalman */}
        <TelemetryPanel
          title="KALMAN FILTER"
          fields={[
            { label: 'EST X',       value: fmt(kal?.position.x, 1), unit: 'px' },
            { label: 'EST Y',       value: fmt(kal?.position.y, 1), unit: 'px' },
            { label: 'PRED X',      value: fmt(kal?.predicted_position?.x, 1), unit: 'px' },
            { label: 'PRED Y',      value: fmt(kal?.predicted_position?.y, 1), unit: 'px' },
            { label: 'UNCERTAINTY', value: fmt(kal?.uncertainty, 1) },
            { label: 'CONVERGED',   value: kal?.converged ? 'YES' : 'NO', highlight: kal?.converged },
          ]}
          columns={2}
        />

        <div className="sidebar-divider" />

        {/* PID */}
        <TelemetryPanel
          title="PID OUTPUT"
          fields={[
            { label: 'PAN CORR',  value: fmt(pid?.pan_correction, 4),  unit: '°' },
            { label: 'TILT CORR', value: fmt(pid?.tilt_correction, 4), unit: '°' },
            { label: 'SETTLED',   value: pid?.settled ? 'YES' : 'NO', highlight: pid?.settled },
          ]}
          compact
        />

        <div className="sidebar-divider" />

        {/* Performance */}
        <TelemetryPanel
          title="PERFORMANCE"
          fields={[
            { label: 'ACQ TIME',    value: met?.acquisition_time !== null && met?.acquisition_time !== undefined ? `${met.acquisition_time.toFixed(3)} s` : '—' },
            { label: 'AVG ERROR',   value: fmt(met?.average_error, 4), unit: '°' },
            { label: 'MAX ERROR',   value: fmt(met?.max_error, 4),     unit: '°' },
            { label: 'LOCK RET',    value: fmt(met?.lock_retention, 1), unit: '%', highlight: (met?.lock_retention ?? 0) > 95 },
            { label: 'DISTURBANCE', value: fmt(dis?.total_disturbance_index, 3), warn: (dis?.total_disturbance_index ?? 0) > 0.4 },
          ]}
        />

        {/* Event log */}
        <div className="sidebar-divider" />
        <div className="sidebar-section-title">EVENT LOG</div>
        <EventLog events={sim.events} maxHeight={200} />
      </div>
    </div>
  );
}
