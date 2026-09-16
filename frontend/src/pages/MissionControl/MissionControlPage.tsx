/**
 * FSOC — Mission Control (Environment)
 * Aerospace console layout: mission header, central 3D digital twin (or
 * fixed 2D sensor feed), compact right telemetry rail, entity bar.
 * All values are live runtime telemetry — unavailable reads render as —.
 */
import React, { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSimulation } from '../../hooks/useSimulation';
import { CameraFeed } from '../../components/simulation/CameraFeed';
import { SimulationViewport } from '../../components/simulation/SimulationViewport';
import type { TwinApi, TwinViewName } from '../../components/simulation/Scene3D';
import { PS169_CONFIG, validatePs169Config } from '../../config/ps169';
import { EventLog } from '../../components/telemetry/EventLog';
import type { TargetState } from '../../types/fsoc';
import { getApiBase } from '../../services/fsocApi';
import './MissionControlPage.css';

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
  fov_h: 4,    // Fixed PS169 value
  fov_v: 3,    // Fixed PS169 value
  max_rate: 5, // Fixed PS169 value
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

// ── Single consistent status language ─────────────────────────
const STATUS_META: Record<TargetState, { label: string; color: string }> = {
  READY:       { label: 'READY',         color: '#8d9195' },
  SEARCHING:   { label: 'SEARCHING',     color: '#e39a32' },
  DETECTED:    { label: 'DETECTED',      color: '#f0b35a' },
  ACQUIRING:   { label: 'ACQUIRING',     color: '#e39a32' },
  TRACKING:    { label: 'TRACKING',      color: '#4fd8cd' },
  LOCKED:      { label: 'LOCKED',        color: '#3ddc84' },
  LOST:        { label: 'TARGET LOST',   color: '#c96a5a' },
  REACQUIRING: { label: 'REACQUIRING',   color: '#e39a32' },
  ERROR:       { label: 'ERROR',         color: '#c96a5a' },
};

const VIEW_OPTIONS: { value: TwinViewName; label: string }[] = [
  { value: 'target', label: 'Target' },
  { value: 'camera', label: 'Camera' },
  { value: 'iso',    label: 'Full' },
  { value: 'top',    label: 'Top' },
  { value: 'front',  label: 'Front' },
  { value: 'side',   label: 'Side' },
  { value: 'reset',  label: 'Reset' },
];

function entityDot(id: string): string {
  if (id === 'SAT-01') return '#7fa8c4';
  if (id === 'FSOC-CAM-01') return '#8fa98f';
  if (id.startsWith('BEACON')) return '#d05a4a';
  return '#e39a32';
}

// Backend frames can carry partial metrics (e.g. pre-run snapshots), so
// every numeric readout goes through this: non-finite → null → '—'.
function num(v: unknown, digits = 1): string | null {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : null;
}

export function MissionControlPage() {
  const sim = useSimulation();
  const nav = useNavigate();

  const [starting, setStarting]     = useState(false);
  const [viewMode, setViewMode]   = useState<'3d' | 'camera'>('3d');
  const [showConfig, setShowConfig] = useState(false);
  const [environment, setEnvironment] = useState<string>('urban');
  const [atmosMode, setAtmosMode]   = useState<AtmosMode>('clear');
  const [multiTarget, setMultiTarget] = useState(false);
  const [platformMotion, setPlatformMotion] = useState<PlatformMotion>('stationary');
  const [target, setTarget]         = useState<TargetForm>(DEFAULT_TARGET);
  const [videoFile, setVideoFile]   = useState<File | null>(null);
  const [videoUploading, setVideoUploading] = useState(false);
  const videoInputRef = useRef<HTMLInputElement>(null);

  // 3D twin external control surface (minimal-chrome embed)
  const [twin, setTwin] = useState<TwinApi | null>(null);
  const [viewSel, setViewSel] = useState<TwinViewName>('target');
  const vizRef = useRef<HTMLDivElement>(null);
  const [isFullView, setIsFullView] = useState(false);

  useEffect(() => {
    const h = () => setIsFullView(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);

  // Full view: toggle fullscreen viewport (layout/presentation only — never modifies camera or tracking).
  const toggleFollowView = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await vizRef.current?.requestFullscreen();
      }
    } catch (e) {
      console.error('Fullscreen view failed', e);
    }
  };

  // UTC wall clock for the mission header
  const [nowUtc, setNowUtc] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNowUtc(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Event-log Clear: hide everything up to the newest visible event id.
  const [clearedEventId, setClearedEventId] = useState<string | null>(null);
  const visibleEvents = clearedEventId
    ? sim.events.slice(sim.events.findIndex(e => e.id === clearedEventId) + 1)
    : sim.events;

  const f   = sim.latest;
  const met = f?.metrics;

  const isRunning = sim.simStatus === 'running';
  const isPaused  = sim.simStatus === 'paused';

  const targetState = (sim.targetState as TargetState) ?? 'READY';
  const statusMeta = STATUS_META[targetState] ?? STATUS_META.READY;

  const simPill = isRunning
    ? { label: 'SIMULATION', color: '#8fa98f' }
    : isPaused
    ? { label: 'PAUSED', color: '#e39a32' }
    : sim.simStatus === 'error'
    ? { label: 'ERROR', color: '#c96a5a' }
    : { label: 'IDLE', color: '#626a6d' };

  const liveTargetId = f?.target?.entity?.id ?? f?.target?.id ?? target.id;
  const liveBeaconId = f?.target?.entity?.beaconId ?? f?.target?.beacon?.id ?? target.id;
  // Target and beacon ids can coincide pre-run (both default to the
  // configured id) — dedupe so React keys stay unique.
  const entityIds = Array.from(new Set(
    viewMode === '3d' && twin ? twin.entityIds : ['SAT-01', 'FSOC-CAM-01', liveTargetId, liveBeaconId],
  ));
  const selectedEntity = viewMode === '3d' ? twin?.selectedId ?? null : null;

  const buildConfig = () => ({
    name: `FSOC-DEMO-042`,
    environment,
    atmospheric_mode: atmosMode,
    multi_target: multiTarget,
    platform_motion: platformMotion,
    camera: {
      // Single source of truth: PS169_CONFIG (640x480, 4°x3°, 30 FPS).
      fov_h: target.fov_h,
      fov_v: target.fov_v,
      resolution_w: PS169_CONFIG.camera.width,
      resolution_h: PS169_CONFIG.camera.height,
      fps: PS169_CONFIG.camera.fps,
    },
    pid: {
      kp: PS169_CONFIG.pid.kp, ki: PS169_CONFIG.pid.ki, kd: PS169_CONFIG.pid.kd,
      max_angular_velocity: target.max_rate,
      settling_threshold: PS169_CONFIG.pid.settlingDeg,
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
      // The whole CONFIGURE panel applies to START DEMO too (demo_mode
      // stays on, so the scripted phase timeline still runs).
      await sim.startDemo(buildConfig());
    } finally {
      setStarting(false);
    }
  };

  const handleStartCustom = async () => {
    setStarting(true);
    try {
      // PS169 configuration is now fixed - no user validation needed
      // Always use PS169 defaults: 640×480, 4°×3°, 30 Hz, 5°/s
      const config = buildConfig();
      // Force PS169 values regardless of target state
      config.camera.fov_h = 4;
      config.camera.fov_v = 3;
      config.pid.max_angular_velocity = 5;
      
      await sim.startCustom(config);
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
    sessionStorage.setItem('asteria-video-upload-pending', '1');
    nav('/tracking');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const base = getApiBase() || 'http://localhost:8000';
      const res = await fetch(`${base}/api/simulation/upload-video`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (data.success) {
        sessionStorage.removeItem('asteria-video-upload-pending');
      }
    } catch (e) {
      console.error('Video upload failed', e);
      sessionStorage.removeItem('asteria-video-upload-pending');
    } finally {
      setVideoUploading(false);
    }
  };

  const utcStr = nowUtc.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  return (
    <div className="mc2-root">

      {/* ── Mission header ─────────────────────────────────── */}
      <header className="mc2-header">
        <div className="mc2-header-right">
          <span className="mc2-clock" title={f && num(f.elapsed) ? `Mission elapsed T+${num(f.elapsed)}s` : 'No active run'}>
            {utcStr}{f && num(f.elapsed) ? `  ·  T+${num(f.elapsed)}s` : ''}
          </span>
          <span className="mc2-simpill">
            <span className="mc2-simdot" style={{ background: simPill.color }} />
            <span style={{ color: simPill.color }}>{simPill.label}</span>
          </span>
        </div>
      </header>

      {/* ── Configuration panel (collapsible, idle only) ───── */}
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

            {/* Test presets */}
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

            <div className="mc-cfg-summary">
              <span className="mc-cfg-sum-item">ID: <b>{target.id}</b></span>
              <span className="mc-cfg-sum-sep">·</span>
              <span className="mc-cfg-sum-item">ENV: <b>{environment.toUpperCase()}</b></span>
              <span className="mc-cfg-sum-sep">·</span>
              <span className="mc-cfg-sum-item">TRAJ: <b>{target.trajectory.toUpperCase()}</b></span>
              <span className="mc-cfg-sum-sep">·</span>
              <span className="mc-cfg-sum-item">POS: <b>({target.start_x}, {target.start_y}, {target.start_z})</b></span>
              <span className="mc-cfg-sum-sep">·</span>
              <span className="mc-cfg-sum-item">FSOC: <b>640×480 · 4°×3° · 30 Hz · 5°/s</b></span>
            </div>
            {videoFile && !videoUploading && (
              <div className="mc-cfg-summary">
                <span className="mc-cfg-sum-item">VIDEO: <b>{videoFile.name}</b></span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Main body ───────────────────────────────────────── */}
      <div className="mc2-body">

        {/* CENTER — primary visualization + entities */}
        <section className="mc2-center">
          <div className="mc2-twin">
            <div className="mc2-twin-head">
              <div className="mc2-twin-titles">
                <div className="mc2-twin-title">{viewMode === '3d' ? '3D DIGITAL TWIN' : 'CAMERA FEED (2D)'}</div>
                <div className="mc2-twin-sub">
                  {viewMode === '3d' ? 'Real-time FSOC Simulation' : 'Fixed sensor · moving FOV rectangle'}
                </div>
              </div>
              {/* Center slot is always mounted (fixed height) so swapping
                  idle ↔ run controls never shifts the page vertically. */}
              <div className="mc2-twin-runcontrols">
                {!isRunning && !isPaused ? (
                  <>
                    <button className="mc2-btn mc2-btn-start" onClick={handleStartDemo} disabled={starting}>
                      {starting ? 'INITIALISING…' : '▶ START DEMO'}
                    </button>
                    <button className="mc2-btn" onClick={handleStartCustom} disabled={starting}>
                      START CUSTOM
                    </button>
                    <button
                      className={`mc2-btn${showConfig ? ' mc2-btn--on' : ''}`}
                      onClick={() => setShowConfig(s => !s)}
                    >
                      CONFIGURE
                    </button>
                    <button className="mc2-btn" onClick={() => videoInputRef.current?.click()} disabled={videoUploading}>
                      {videoUploading ? 'PROCESSING…' : 'UPLOAD VIDEO'}
                    </button>
                    <input
                      ref={videoInputRef}
                      type="file"
                      accept="video/mp4,video/*"
                      style={{ display: 'none' }}
                      onChange={e => { const fl = e.target.files?.[0]; if (fl) handleVideoUpload(fl); }}
                    />
                  </>
                ) : (
                  <>
                    <button
                      className="mc2-btn mc2-btn-pause"
                      onClick={() => sim.pause()}
                      title={isPaused ? 'Resume the simulation' : 'Freeze simulation state'}
                    >
                      {isPaused ? '▶ RESUME' : '❚❚ PAUSE'}
                    </button>
                    <button
                      className="mc2-btn mc2-btn-end"
                      onClick={() => sim.endDemo()}
                      title="End demo and clear runtime-created entities"
                    >
                      ◼ END DEMO
                    </button>
                  </>
                )}
              </div>
              <div className="mc2-twin-head-right">
                <div className="mc2-seg" role="tablist" aria-label="Visualization mode">
                  <button
                    type="button"
                    className={`mc2-seg-btn${viewMode === '3d' ? ' mc2-seg-btn--on' : ''}`}
                    onClick={() => setViewMode('3d')}
                  >
                    3D
                  </button>
                  <button
                    type="button"
                    className={`mc2-seg-btn${viewMode === 'camera' ? ' mc2-seg-btn--on' : ''}`}
                    onClick={() => setViewMode('camera')}
                  >
                    2D
                  </button>
                </div>
              </div>
            </div>

            <div className="mc2-viz" ref={vizRef}>
              {viewMode === '3d' ? (
                <SimulationViewport frame={f} history={sim.history} minimalChrome onTwinApi={setTwin} simStatus={sim.simStatus} />
              ) : (
                <CameraFeed
                  frame={f}
                  width={640}
                  height={480}
                  atmosMode={atmosMode}
                  noiseMode="gaussian"
                  beaconShape={target.beaconShape}
                  beaconSize={target.beaconSize}
                />
              )}
              {/* Overlays render AFTER the canvas so they always paint above it,
                  in normal and fullscreen mode alike. */}
              {viewMode === '3d' && (
                <div className="mc2-viz-status" title="Live tracking state">
                  <span className="mc2-status-dot" style={{ background: statusMeta.color }} />
                  <span style={{ color: statusMeta.color }}>{statusMeta.label}</span>
                </div>
              )}
              {viewMode === '3d' && (
                <div className="mc2-viz-controls">
                  <label className="mc2-select-wrap">
                    <span className="mc2-select-tag">View:</span>
                    <select
                      className="mc2-select"
                      value={viewSel}
                      onChange={e => {
                        const v = e.target.value as TwinViewName;
                        setViewSel(v);
                        twin?.requestView(v);
                      }}
                      disabled={!twin}
                      title="One-time viewer focus preset (visualization only)"
                    >
                      {VIEW_OPTIONS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className={`mc2-btn mc2-btn-view${twin?.cameraMode === 'follow' ? ' mc2-btn--on' : ''}`}
                    onClick={toggleFollowView}
                    disabled={!twin}
                    title="Fullscreen viewport with viewer following the selection (visualization only)"
                  >
                    {isFullView ? '⛶ EXIT' : '⛶ VIEW'}
                  </button>
                </div>
              )}
              {viewMode === '3d' && (
                <div className="mc2-toggles" role="group" aria-label="Visualization layers">
                  {(['fov', 'labels'] as const).map(k => {
                    const on = twin?.toggles[k] ?? true;
                    return (
                      <button
                        key={k}
                        type="button"
                        className={`mc2-tgl${on ? ' mc2-tgl--on' : ''}`}
                        onClick={() => twin && twin.setToggle(k, !twin.toggles[k])}
                        disabled={!twin}
                        title={k === 'fov' ? 'FSOC optical FOV cone' : 'Entity labels'}
                      >
                        <span className="mc2-tgl-dot" />
                        {k === 'fov' ? 'FOV' : 'Labels'}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="mc2-entities">
              <span className="mc2-entities-label">ENTITIES</span>
              <div className="mc2-entities-row">
                {entityIds.map(id => {
                  const selected = selectedEntity === id;
                  const interactive = viewMode === '3d' && !!twin;
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`mc2-ent${selected ? ' mc2-ent--sel' : ''}`}
                      onClick={() => { if (interactive) twin!.select(selected ? null : id); }}
                      disabled={!interactive}
                      title={interactive ? `Select ${id} in the twin` : id}
                    >
                      <span className="mc2-ent-dot" style={{ background: entityDot(id) }} />
                      {id}
                    </button>
                  );
                })}
              </div>
              {viewMode === '3d' && (
                <div className="mc2-entities-add">
                  <button
                    type="button"
                    className="mc2-ent-add"
                    onClick={() => twin?.addEntity('target')}
                    disabled={!twin}
                    title="Spawn an operator-owned target platform in the twin"
                  >
                    + TARGET
                  </button>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* RIGHT — mission / tracking / performance / events */}
        <aside className="mc2-rail">
          <div className="mc2-card">
            <div className="mc2-card-head">MISSION</div>
            <div className="mc2-rows">
              <div className="mc2-row"><span className="mc2-key">Scenario</span><span className="mc2-val">{environment.replace('_', ' ').toUpperCase()}</span></div>
              <div className="mc2-row"><span className="mc2-key">Target</span><span className="mc2-val">{liveTargetId}</span></div>
              <div className="mc2-row"><span className="mc2-key">Trajectory</span><span className="mc2-val">{target.trajectory.toUpperCase()}</span></div>
              <div className="mc2-row">
                <span className="mc2-key">Status</span>
                <span className="mc2-val" style={{ color: statusMeta.color }}>
                  <span className="mc2-status-dot" style={{ background: statusMeta.color }} />
                  {statusMeta.label}
                </span>
              </div>
            </div>
          </div>

          <div className="mc2-card">
            <div className="mc2-card-head">TRACKING</div>
            <div className="mc2-rows">
              <div className="mc2-row">
                <span className="mc2-key">Confidence</span>
                <span className="mc2-val">{num(met?.detection_confidence, 3) != null ? `${((met?.detection_confidence ?? 0) * 100).toFixed(1)} %` : '—'}</span>
              </div>
              <div className="mc2-row">
                <span className="mc2-key">PAN</span>
                <span className="mc2-val">{num(f?.camera?.pan, 2) != null ? `${num(f?.camera?.pan, 2)} °` : '—'}</span>
              </div>
              <div className="mc2-row">
                <span className="mc2-key">TILT</span>
                <span className="mc2-val">{num(f?.camera?.tilt, 2) != null ? `${num(f?.camera?.tilt, 2)} °` : '—'}</span>
              </div>
              <div className="mc2-row">
                <span className="mc2-key">Error</span>
                <span className="mc2-val">{num(f?.pixel_error?.total) != null ? `${num(f?.pixel_error?.total)} px` : '—'}</span>
              </div>
            </div>
          </div>

          <div className="mc2-card">
            <div className="mc2-card-head">PERFORMANCE</div>
            <div className="mc2-rows">
              <div className="mc2-row">
                <span className="mc2-key">FPS</span>
                <span className="mc2-val">{num(met?.fps) ?? '—'}</span>
              </div>
              <div className="mc2-row">
                <span className="mc2-key">Latency</span>
                <span className="mc2-val">{num(met?.processing_ms) != null ? `${num(met?.processing_ms)} ms` : '—'}</span>
              </div>
              <div className="mc2-row">
                <span className="mc2-key">Avg Error</span>
                <span className="mc2-val">{num(met?.average_error_px) != null ? `${num(met?.average_error_px)} px` : '—'}</span>
              </div>
              <div className="mc2-row">
                <span className="mc2-key">Lock Retention</span>
                <span className="mc2-val">{num(met?.lock_retention) != null && (met?.lock_retention ?? 0) > 0 ? `${num(met?.lock_retention)} %` : '—'}</span>
              </div>
            </div>
          </div>

          <div className="mc2-card mc2-card--log">
            <div className="mc2-card-head mc2-log-head">
              <span>EVENT LOG</span>
              <button
                type="button"
                className="mc2-clear"
                onClick={() => setClearedEventId(visibleEvents.length ? visibleEvents[visibleEvents.length - 1].id : null)}
                disabled={visibleEvents.length === 0}
              >
                Clear
              </button>
            </div>
            <EventLog events={visibleEvents} maxHeight={180} />
          </div>
        </aside>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────

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
