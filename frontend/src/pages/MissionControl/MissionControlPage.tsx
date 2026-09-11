/**
 * FSOC — Mission Control
 * Primary landing screen. Camera feed + target config + live metrics.
 */
import React, { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSimulation } from '../../hooks/useSimulation';
import { CameraFeed } from '../../components/simulation/CameraFeed';
import { SimulationViewport } from '../../components/simulation/SimulationViewport';
import { TargetStateIndicator } from '../../components/telemetry/TargetStateIndicator';
import { EventLog } from '../../components/telemetry/EventLog';
import type { TargetState } from '../../types/fsoc';

// ── Target configuration form state ───────────────────────────
interface TargetForm {
  id: string;
  trajectory: 'sinusoidal' | 'circular' | 'linear' | 'random_walk' | 'figure_8';
  amplitude_h: number;
  amplitude_v: number;
  period: number;
  speed_x: number;
  speed_y: number;
  start_x: number;
  start_y: number;
  start_z: number;
  beaconShape: 'square' | 'circle';
  beaconSize: number;
  fov_h: number;
  fov_v: number;
  max_rate: number;
}

const DEFAULT_TARGET: TargetForm = {
  id: 'BEACON-01',
  trajectory: 'sinusoidal',
  amplitude_h: 90,
  amplitude_v: 45,
  period: 18,
  speed_x: 2.5,
  speed_y: 0.8,
  start_x: 120,
  start_y: 60,
  start_z: 350,
  beaconShape: 'square',
  beaconSize: 10,
  fov_h: 4,
  fov_v: 3,
  max_rate: 5,
};

// Closed-loop test presets (clean conditions: configure, then START CUSTOM)
const TEST_PRESETS: { name: string; patch: Partial<TargetForm> }[] = [
  { name: 'TEST 1 · STRAIGHT', patch: { trajectory: 'linear', start_x: -8, start_y: 2, start_z: 350, speed_x: 6, speed_y: 0.3 } },
  { name: 'TEST 2 · CIRCULAR', patch: { trajectory: 'circular', start_x: 0, start_y: 2, start_z: 350, amplitude_h: 8, amplitude_v: 5, period: 14 } },
  { name: 'TEST 3 · FIGURE-8', patch: { trajectory: 'figure_8', start_x: 0, start_y: 2, start_z: 350, amplitude_h: 8, amplitude_v: 5, period: 14 } },
  { name: 'TEST 4 · RANDOM', patch: { trajectory: 'random_walk', start_x: 0, start_y: 2, start_z: 350, speed_x: 1, speed_y: 0.3 } },
];

const ENVIRONMENTS = ['urban', 'open_sky', 'mountain', 'uav', 'satellite'] as const;
const TRAJECTORIES = ['sinusoidal', 'circular', 'linear', 'random_walk', 'figure_8'] as const;
const ATMOS_MODES  = ['clear', 'haze', 'fog', 'rain', 'low_light'] as const;
const PLATFORM_MOTIONS = ['stationary', 'linear', 'uav_hover', 'orbital', 'circular_patrol'] as const;
type AtmosMode = typeof ATMOS_MODES[number];
type PlatformMotion = typeof PLATFORM_MOTIONS[number];

export function MissionControlPage() {
  const sim = useSimulation();
  const nav = useNavigate();

  const [starting, setStarting]     = useState(false);
  const [viewMode, setViewMode]   = useState<'camera' | '3d'>('3d');
  const [showConfig, setShowConfig] = useState(false);
  const [environment, setEnvironment] = useState<string>('urban');
  const [atmosMode, setAtmosMode]   = useState<AtmosMode>('clear');
  const [multiTarget, setMultiTarget] = useState(false);
  const [platformMotion, setPlatformMotion] = useState<PlatformMotion>('stationary');
  const [target, setTarget]         = useState<TargetForm>(DEFAULT_TARGET);
  const [videoFile, setVideoFile]   = useState<File | null>(null);
  const [videoUploading, setVideoUploading] = useState(false);
  const videoInputRef = useRef<HTMLInputElement>(null);

  const f   = sim.latest;
  const met = f?.metrics;

  // Same authoritative disturbance state as the Disturbance Lab.
  // ON if the shared store says so or a live telemetry echo confirms it.
  const turbActive = sim.disturbances.atmospheric_turbulence.enabled
    || (f?.disturbance?.config?.atmospheric_turbulence?.enabled ?? false);
  const activeDistCount = f?.disturbance?.active_count ?? 0;

  const isRunning = sim.simStatus === 'running';
  const isPaused  = sim.simStatus === 'paused';

  const buildConfig = () => ({
    name: `FSOC-DEMO-042`,
    environment,
    atmospheric_mode: atmosMode,
    multi_target: multiTarget,
    platform_motion: platformMotion,
    camera: {
      fov_h: target.fov_h,
      fov_v: target.fov_v,
      resolution_w: 640,
      resolution_h: 480,
      fps: 30,
    },
    pid: {
      kp: 6.0, ki: 0.15, kd: 0.6,
      max_angular_velocity: target.max_rate,
      settling_threshold: 0.05,
    },
    target: {
      id: target.id,
      trajectory: target.trajectory,
      initial_position: { x: target.start_x, y: target.start_y, z: target.start_z },
      velocity: { x: target.speed_x, y: target.speed_y, z: 0 },
      amplitude_h: target.amplitude_h,
      amplitude_v: target.amplitude_v,
      period: target.period,
      beacon_shape: target.beaconShape,
      beacon_size: target.beaconSize,
    },
  });

  const handleStartDemo = async () => {
    setStarting(true);
    try {
      await sim.startDemo();
    } finally {
      setStarting(false);
    }
  };

  const handleStartCustom = async () => {
    setStarting(true);
    try {
      await sim.startCustom(buildConfig());
    } finally {
      setStarting(false);
    }
  };

  const setT = (k: keyof TargetForm, v: string | number) =>
    setTarget(prev => ({ ...prev, [k]: v }));

  // ── Video upload handler (Benchmark 2) ─────────────────────
  const handleVideoUpload = async (file: File) => {
    setVideoFile(file);
    setVideoUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('http://localhost:8000/api/simulation/upload-video', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      // Navigate to tracking page as soon as upload is accepted (processing is async via WS)
      if (data.success) {
        setTimeout(() => nav('/tracking'), 400);
      }
    } catch (e) {
      console.error('Video upload failed', e);
    } finally {
      setVideoUploading(false);
    }
  };

  return (
    <div className="mc-root">

      {/* ── Top bar ─────────────────────────────────────────── */}
      <div className="mc-topbar">
        <div className="mc-topbar-left">
          <span className="mc-eyebrow">ASTERIA · FSOC COARSE ALIGNMENT · PS169</span>
          <span className="mc-title">Mission Control</span>
        </div>

        <div className="mc-topbar-center">
          {!isRunning && !isPaused ? (
            <div className="mc-start-group">
              <button
                className="mc-btn-start"
                onClick={handleStartDemo}
                disabled={starting}
              >
                <span className="mc-btn-icon">▶</span>
                {starting ? 'INITIALISING…' : 'START DEMO'}
              </button>
              <button
                className="mc-btn-custom"
                onClick={handleStartCustom}
                disabled={starting}
                title="Start with custom target configuration"
              >
                START CUSTOM
              </button>
              <button
                className={`mc-btn-config${showConfig ? ' mc-btn-config--active' : ''}`}
                onClick={() => setShowConfig(s => !s)}
                title="Configure target & environment"
              >
                ⚙ CONFIGURE
              </button>
              {/* Benchmark 2 — Video input mode */}
              <button
                className="mc-btn-video"
                onClick={() => videoInputRef.current?.click()}
                disabled={videoUploading}
                title="Upload MP4 for Benchmark 2 evaluation"
              >
                {videoUploading ? '⏳ PROCESSING…' : '📹 UPLOAD VIDEO'}
              </button>
              <input
                ref={videoInputRef}
                type="file"
                accept="video/mp4,video/*"
                style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleVideoUpload(f); }}
              />
              {videoFile && !videoUploading && (
                <span className="mc-video-name" title={videoFile.name}>
                  📹 {videoFile.name.slice(0, 20)}{videoFile.name.length > 20 ? '…' : ''}
                </span>
              )}
            </div>
          ) : (
            <div className="mc-running-controls">
              <button className="mc-btn-ctrl mc-btn-pause" onClick={() => sim.pause()}>
                {isPaused ? '▶ RESUME' : '⏸ PAUSE'}
              </button>
              <button className="mc-btn-ctrl mc-btn-stop" onClick={() => sim.stop()}>
                ■ STOP
              </button>
              <button className="mc-btn-ctrl mc-btn-track" onClick={() => nav('/tracking')}>
                TRACKING →
              </button>
            </div>
          )}
        </div>

        <div className="mc-topbar-right">
          {turbActive && (
            <div
              className="mc-ws-pill"
              data-status="warning"
              title={`Atmospheric turbulence active — ${activeDistCount} disturbance(s) live`}
            >
              <span className="mc-ws-dot" />
              ATMOSPHERIC TURBULENCE ACTIVE
            </div>
          )}
          <div className="mc-ws-pill" data-status={sim.wsStatus}>
            <span className="mc-ws-dot" />
            {sim.wsStatus === 'connected' ? 'TELEMETRY LIVE'
             : sim.wsStatus === 'error'   ? 'CONN ERROR'
             : 'OFFLINE'}
          </div>
        </div>
      </div>

      {/* ── Configuration panel (collapsible) ───────────────── */}
      {showConfig && !isRunning && !isPaused && (
        <div className="mc-config-panel">
          <div className="mc-config-inner">

            {/* Environment */}
            <div className="mc-cfg-group">
              <div className="mc-cfg-label">ENVIRONMENT</div>
              <div className="mc-cfg-row">
                {ENVIRONMENTS.map(e => (
                  <button
                    key={e}
                    className={`mc-cfg-chip${environment === e ? ' mc-cfg-chip--on' : ''}`}
                    onClick={() => setEnvironment(e)}
                  >
                    {e.replace('_', ' ').toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {/* Target ID */}
            <div className="mc-cfg-group">
              <div className="mc-cfg-label">CLOSED-LOOP TEST PRESETS (CLEAN: NOISE OFF · CLEAR · STATIONARY)</div>
              <div className="mc-cfg-row">
                {TEST_PRESETS.map(t => (
                  <button
                    key={t.name}
                    className="mc-cfg-chip"
                    onClick={() => {
                      setTarget(prev => ({ ...prev, ...t.patch }));
                      setMultiTarget(false);
                      setPlatformMotion('stationary');
                    }}
                    title="Load preset, then START CUSTOM"
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </div>

            {/* Target ID */}
            <div className="mc-cfg-group">
              <div className="mc-cfg-label">TARGET ID</div>
              <input
                className="mc-cfg-input"
                value={target.id}
                onChange={e => setT('id', e.target.value)}
                placeholder="BEACON-01"
              />
            </div>

            {/* Trajectory */}
            <div className="mc-cfg-group">
              <div className="mc-cfg-label">TRAJECTORY</div>
              <div className="mc-cfg-row">
                {TRAJECTORIES.map(t => (
                  <button
                    key={t}
                    className={`mc-cfg-chip${target.trajectory === t ? ' mc-cfg-chip--on' : ''}`}
                    onClick={() => setT('trajectory', t)}
                  >
                    {t.replace(/_/g, ' ').toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {/* Target Mode: Single vs Multi-Target */}
            <div className="mc-cfg-group">
              <div className="mc-cfg-label">TARGET MODE (BEACONS)</div>
              <div className="mc-cfg-row">
                <button
                  className={`mc-cfg-chip${!multiTarget ? ' mc-cfg-chip--on' : ''}`}
                  onClick={() => setMultiTarget(false)}
                >
                  SINGLE BEACON (BEACON-01)
                </button>
                <button
                  className={`mc-cfg-chip${multiTarget ? ' mc-cfg-chip--on' : ''}`}
                  onClick={() => setMultiTarget(true)}
                >
                  MULTI-TARGET (2 BEACONS)
                </button>
              </div>
            </div>

            {/* Host Platform Motion */}
            <div className="mc-cfg-group">
              <div className="mc-cfg-label">HOST PLATFORM MOTION</div>
              <div className="mc-cfg-row">
                {PLATFORM_MOTIONS.map(pm => (
                  <button
                    key={pm}
                    className={`mc-cfg-chip${platformMotion === pm ? ' mc-cfg-chip--on' : ''}`}
                    onClick={() => setPlatformMotion(pm)}
                  >
                    {pm === 'stationary' ? 'STATIONARY'
                      : pm === 'linear' ? 'LINEAR (PS169 MANDATORY)'
                      : pm === 'uav_hover' ? 'UAV HOVER/SWAY'
                      : pm === 'orbital' ? 'LEO SATELLITE'
                      : 'CIRCULAR PATROL'}
                  </button>
                ))}
              </div>
            </div>

            {/* Atmospheric Visual Mode */}
            <div className="mc-cfg-group">
              <div className="mc-cfg-label">ATMOSPHERIC CONDITION</div>
              <div className="mc-cfg-row">
                {ATMOS_MODES.map(m => (
                  <button
                    key={m}
                    className={`mc-cfg-chip${atmosMode === m ? ' mc-cfg-chip--on' : ''}`}
                    onClick={() => setAtmosMode(m)}
                  >
                    {m.replace('_', ' ').toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {/* Motion parameters */}
            <div className="mc-cfg-params-grid">
              {target.trajectory === 'sinusoidal' || target.trajectory === 'circular' || target.trajectory === 'figure_8' ? (
                <>
                  <CfgSlider label="Amplitude H (m)" value={target.amplitude_h} min={10} max={200} step={5}  onChange={v => setT('amplitude_h', v)} />
                  <CfgSlider label="Amplitude V (m)" value={target.amplitude_v} min={5}  max={120} step={5}  onChange={v => setT('amplitude_v', v)} />
                  <CfgSlider label="Period (s)"       value={target.period}      min={4}  max={60}  step={1}  onChange={v => setT('period', v)} />
                </>
              ) : (
                <>
                  <CfgSlider label="Speed X (m/s)" value={target.speed_x} min={0.1} max={15} step={0.1} onChange={v => setT('speed_x', v)} />
                  <CfgSlider label="Speed Y (m/s)" value={target.speed_y} min={0}   max={8}  step={0.1} onChange={v => setT('speed_y', v)} />
                </>
              )}
              <CfgSlider label="Start X (m)" value={target.start_x} min={-300} max={300} step={10} onChange={v => setT('start_x', v)} />
              <CfgSlider label="Start Y (m)" value={target.start_y} min={-100} max={200} step={5}  onChange={v => setT('start_y', v)} />
              <CfgSlider label="Start Z (m)" value={target.start_z} min={50}   max={800} step={10} onChange={v => setT('start_z', v)} />
            </div>

            {/* Beacon shape + size */}
            <div className="mc-cfg-group">
              <div className="mc-cfg-label">BEACON SHAPE</div>
              <div className="mc-cfg-row">
                {(['square', 'circle'] as const).map(s => (
                  <button
                    key={s}
                    className={`mc-cfg-chip${target.beaconShape === s ? ' mc-cfg-chip--on' : ''}`}
                    onClick={() => setT('beaconShape', s)}
                  >
                    {s.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <div className="mc-cfg-params-grid">
              <CfgSlider label="Beacon Size (px)" value={target.beaconSize} min={5} max={20} step={1} onChange={v => setT('beaconSize', v)} />
            </div>

            {/* Virtual FSOC camera (PS169 defaults: 640×480, 4°×3°, 30 Hz, 5°/s) */}
            <div className="mc-cfg-group">
              <div className="mc-cfg-label">FSOC VIRTUAL CAMERA</div>
            </div>
            <div className="mc-cfg-params-grid">
              <CfgSlider label="FOV-H (°)" value={target.fov_h} min={2} max={12} step={0.5} onChange={v => setT('fov_h', v)} />
              <CfgSlider label="FOV-V (°)" value={target.fov_v} min={2} max={9} step={0.5} onChange={v => setT('fov_v', v)} />
              <CfgSlider label="Max Rate (°/s)" value={target.max_rate} min={1} max={15} step={0.5} onChange={v => setT('max_rate', v)} />
            </div>
            <div className="mc-cfg-summary">
              <span className="mc-cfg-sum-item">ID: <b>{target.id}</b></span>
              <span className="mc-cfg-sum-sep">·</span>
              <span className="mc-cfg-sum-item">ENV: <b>{environment.toUpperCase()}</b></span>
              <span className="mc-cfg-sum-sep">·</span>
              <span className="mc-cfg-sum-item">TRAJ: <b>{target.trajectory.toUpperCase()}</b></span>
              <span className="mc-cfg-sum-sep">·</span>
              <span className="mc-cfg-sum-item">POS: <b>({target.start_x}, {target.start_y}, {target.start_z})</b></span>
            </div>
          </div>
        </div>
      )}

      {/* ── Main body ───────────────────────────────────────── */}
      <div className="mc-body">

        {/* LEFT — camera feed / 3d view */}
        <div className="mc-feed-col">
          <div className={`mc-feed-wrapper${viewMode === '3d' ? ' mc-feed-wrapper--3d' : ''}`}>
            <div className="mc-view-toggle" role="tablist" aria-label="Mission visualisation">
              <button
                type="button"
                className={`mc-view-btn${viewMode === 'camera' ? ' mc-view-btn--active' : ''}`}
                onClick={() => setViewMode('camera')}
              >
                CAMERA FEED (2D)
              </button>
              <button
                type="button"
                className={`mc-view-btn${viewMode === '3d' ? ' mc-view-btn--active' : ''}`}
                onClick={() => setViewMode('3d')}
              >
                3-D VIEW
              </button>
            </div>
            <div className="mc-state-overlay">
              <TargetStateIndicator
                state={(sim.targetState as TargetState) ?? 'READY'}
                large
              />
            </div>
            {viewMode === 'camera' ? (
              <CameraFeed frame={f} width={640} height={480} atmosMode={atmosMode} noiseMode="gaussian" beaconShape={target.beaconShape} beaconSize={target.beaconSize} />
            ) : (
              <div className="mc-3d-canvas">
                <SimulationViewport frame={f} history={sim.history} />
              </div>
            )}
          </div>

          {!isRunning && !isPaused && (
            <div className="mc-demo-steps">
              <span className="mc-demo-steps-label">DEMO SEQUENCE</span>
              <div className="mc-steps-grid">
                {[
                  'Initialise environment', 'Spawn optical beacon',
                  'AI detects beacon',      'Kalman predicts trajectory',
                  'PID centres camera',     'TARGET LOCKED',
                  'Introduce turbulence',   'Platform vibration',
                  'Controller compensates', 'Performance summary',
                ].map((step, i) => (
                  <div key={i} className="mc-step">
                    <span className="mc-step-n">{String(i+1).padStart(2,'0')}</span>
                    <span className="mc-step-label">{step}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT — telemetry + events */}
        <div className="mc-stats-col">
          <div className="mc-id-block">
            {[
              ['MISSION',     'FSOC-DEMO-042'],
              ['SCENARIO',    environment.replace('_',' ').toUpperCase()],
              ['TARGET',      target.id],
              ['TRAJECTORY',  target.trajectory.toUpperCase()],
              ['DETECTOR',    'MOCK / YOLO-READY'],
            ].map(([k, v]) => (
              <div key={k} className="mc-id-row">
                <span className="mc-id-key">{k}</span>
                <span className="mc-id-val">{v}</span>
              </div>
            ))}
          </div>

          <div className="mc-sep" />

          <div className="mc-metrics-grid">
            <Metric label="ACQUISITION"  value={met?.acquisition_time != null ? `${met.acquisition_time.toFixed(2)} s` : '—'} ok={met?.acquisition_time != null} />
            <Metric label="AVG ERROR"    value={met?.average_error != null ? `${met.average_error.toFixed(3)}°` : '—'} />
            <Metric label="MAX ERROR"    value={met?.max_error != null ? `${met.max_error.toFixed(3)}°` : '—'} warn={(met?.max_error ?? 0) > 3} />
            <Metric label="AVG ERR PX"   value={met?.average_error_px != null ? `${met.average_error_px.toFixed(2)} px` : '—'} />
            <Metric label="RMSE PX"      value={met?.rmse_px != null ? `${met.rmse_px.toFixed(2)} px` : '—'} ok={(met?.rmse_px ?? 99) <= 10} />
            <Metric label="LOCK RET."    value={met?.lock_retention != null ? `${met.lock_retention.toFixed(1)}%` : '—'} ok={(met?.lock_retention ?? 0) > 95} />
            <Metric label="FPS"          value={met?.fps != null ? met.fps.toFixed(1) : '—'} />
            <Metric label="LATENCY"      value={met?.processing_ms != null ? `${met.processing_ms.toFixed(1)} ms` : '—'} />
            <Metric label="CONFIDENCE"   value={met?.detection_confidence != null ? `${(met.detection_confidence*100).toFixed(1)}%` : '—'} ok={(met?.detection_confidence ?? 0) > 0.9} />
            <Metric label="PAN"          value={f?.camera.pan  != null ? `${f.camera.pan.toFixed(2)}°` : '—'} />
            <Metric label="TILT"         value={f?.camera.tilt != null ? `${f.camera.tilt.toFixed(2)}°` : '—'} />
            <Metric label="TOTAL ERR"    value={f?.angular_error?.total_error != null ? `${f.angular_error.total_error.toFixed(3)}°` : '—'} warn={(f?.angular_error?.total_error ?? 0) > 2} />
          </div>

          <div className="mc-sep" />
          <div className="mc-section-label">SYSTEM EVENTS</div>
          <EventLog events={sim.events} maxHeight={200} />

          <div className="mc-sep" />
          <div className="mc-quicknav">
            {([
              ['Live Tracking', '/tracking'],
              ['Detection',     '/detection'],
              ['Disturbances',  '/disturbances'],
              ['Analytics',     '/analytics'],
              ['Reports',       '/reports'],
              ['Copilot',       '/copilot'],
            ] as [string,string][]).map(([label, path]) => (
              <button key={path} className="mc-qnav-btn" onClick={() => nav(path)}>
                {label} →
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────

function Metric({ label, value, ok, warn }: { label: string; value: string; ok?: boolean; warn?: boolean }) {
  return (
    <div className="mc-metric">
      <span className="mc-metric-label">{label}</span>
      <span className={`mc-metric-val${ok ? ' mc-metric-ok' : warn ? ' mc-metric-warn' : ''}`}>{value}</span>
    </div>
  );
}

function CfgSlider({ label, value, min, max, step, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mc-cfg-param">
      <div className="mc-cfg-param-header">
        <span className="mc-cfg-param-label">{label}</span>
        <span className="mc-cfg-param-val">{value}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="mc-cfg-slider"
      />
    </div>
  );
}
