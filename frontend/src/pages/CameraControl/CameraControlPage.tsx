/**
 * FSOC — Camera Control Page
 * Pan/tilt manual control + PID parameter tuning.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useSimulation } from '../../hooks/useSimulation';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import type { TelemetryFrame } from '../../types/fsoc';

const CHART_WINDOW = 150;

export function CameraControlPage() {
  const sim = useSimulation();
  const f = sim.latest;

  const [pan,  setPan]  = useState(0);
  const [tilt, setTilt] = useState(0);
  const [camError, setCamError] = useState<string | null>(null);
  const [camBusy, setCamBusy] = useState(false);
  // Command → echo tracking: proves every slider move reached the backend
  // AND came back via telemetry. If the POST succeeds but no echo arrives,
  // the backend is stale (ai-service not restarted) — say so explicitly
  // instead of leaving the user staring at frozen 0.00° values.
  const [lastCmd, setLastCmd] = useState<{ pan: number; tilt: number; at: number } | null>(null);
  const [echoState, setEchoState] = useState<'idle' | 'waiting' | 'confirmed' | 'stale'>('idle');
  // Sliders start at the LIVE gimbal position (not 0) and only diverge
  // once the operator grabs them — otherwise the slider jumps from 0
  // while the camera is e.g. at +40°, which looks broken.
  const touchedPan = useRef(false);
  const touchedTilt = useRef(false);

  useEffect(() => {
    if (!touchedPan.current && f?.camera.pan !== undefined) setPan(f.camera.pan);
  }, [f?.camera.pan]);
  useEffect(() => {
    if (!touchedTilt.current && f?.camera.tilt !== undefined) setTilt(f.camera.tilt);
  }, [f?.camera.tilt]);

  // Live-apply: every slider / d-pad move is sent to the backend
  // immediately. Previously these only updated local state and did
  // nothing until APPLY was pressed, so dragging felt dead.
  const sendCamera = useCallback(async (nextPan: number, nextTilt: number) => {
    setCamBusy(true);
    setCamError(null);
    setEchoState('waiting');
    try {
      await sim.updateCamera(nextPan, nextTilt);
      setLastCmd({ pan: nextPan, tilt: nextTilt, at: Date.now() });
      setEchoState('waiting');
    } catch (e) {
      setCamError(e instanceof Error ? e.message : 'Camera update failed');
      setEchoState('idle');
    } finally {
      setCamBusy(false);
    }
  }, [sim]);

  const handlePanChange = useCallback((nextPan: number) => {
    touchedPan.current = true;
    setPan(nextPan);
    void sendCamera(nextPan, tilt);
  }, [tilt, sendCamera]);

  const handleTiltChange = useCallback((nextTilt: number) => {
    touchedTilt.current = true;
    setTilt(nextTilt);
    void sendCamera(pan, nextTilt);
  }, [pan, sendCamera]);

  const handleManualCamera = useCallback(async () => {
    await sendCamera(pan, tilt);
  }, [pan, tilt, sendCamera]);

  const [pid, setPid] = useState({
    kp: 0.8, ki: 0.05, kd: 0.3,
    max_angular_velocity: 15.0,
    settling_threshold: 0.5,
  });

  const handlePIDApply = useCallback(async () => {
    await sim.updatePID(pid);
  }, [pid, sim]);

  // Chart data
  const chartData = sim.history.slice(-CHART_WINDOW).map((fr: TelemetryFrame, i: number) => ({
    i,
    pan:      fr.camera.pan,
    tilt:     fr.camera.tilt,
    panErr:   fr.angular_error.pan_error,
    tiltErr:  fr.angular_error.tilt_error,
  }));

  const currentPan  = f?.camera.pan  ?? 0;
  const currentTilt = f?.camera.tilt ?? 0;

  // Echo confirmation: telemetry caught up with the last command.
  useEffect(() => {
    if (!lastCmd || echoState !== 'waiting') return;
    if (Math.abs(currentPan - lastCmd.pan) < 0.6 && Math.abs(currentTilt - lastCmd.tilt) < 0.6) {
      setEchoState('confirmed');
    }
  }, [currentPan, currentTilt, lastCmd, echoState]);

  // Stale detection: POST ok but no telemetry echo within 2.5 s.
  useEffect(() => {
    if (!lastCmd || echoState !== 'waiting') return;
    const id = setTimeout(() => {
      setEchoState(prev => (prev === 'waiting' ? 'stale' : prev));
    }, 2500);
    return () => clearTimeout(id);
  }, [lastCmd, echoState]);

  const normalize = (val: number, min: number, max: number) =>
    ((val - min) / (max - min)) * 100;

  return (
    <div className="page-camera">
      <div className="page-header">
        <h2 className="page-title">Camera Control</h2>
        <span className="page-subtitle">Pan · Tilt · PID Configuration</span>
        {f?.manual_hold && (
          <span className="cam-hold-badge">
            MANUAL HOLD{f?.manual_hold_remaining ? ` · ${f.manual_hold_remaining.toFixed(0)}s` : ''}
          </span>
        )}
      </div>

      <div className="camera-body">
        {/* ── Left: manual control ───────────────────────── */}
        <div className="camera-control-col">

          {/* Pan slider */}
          <div className="cam-control-block">
            <div className="cam-axis-header">
              <span className="cam-axis-label">PAN</span>
              <span className="cam-axis-range">−180° → +180°</span>
              <span className="cam-axis-current">{currentPan.toFixed(2)}°</span>
            </div>
            <div className="cam-slider-track">
              <span className="cam-slider-tick">−180°</span>
              <input
                type="range"
                min={-180} max={180} step={0.1}
                value={pan}
                onChange={e => handlePanChange(Number(e.target.value))}
                className="cam-slider"
              />
              <span className="cam-slider-tick">+180°</span>
            </div>
            <div className="cam-slider-val">{pan.toFixed(1)}°</div>
          </div>

          {/* Tilt slider */}
          <div className="cam-control-block">
            <div className="cam-axis-header">
              <span className="cam-axis-label">TILT</span>
              <span className="cam-axis-range">−89° → +89°</span>
              <span className="cam-axis-current">{currentTilt.toFixed(2)}°</span>
            </div>
            <div className="cam-slider-track">
              <span className="cam-slider-tick">−89°</span>
              <input
                type="range"
                min={-89} max={89} step={0.1}
                value={tilt}
                onChange={e => handleTiltChange(Number(e.target.value))}
                className="cam-slider"
              />
              <span className="cam-slider-tick">+89°</span>
            </div>
            <div className="cam-slider-val">{tilt.toFixed(1)}°</div>
          </div>

          {/* D-pad controls */}
          <div className="cam-dpad">
            <button className="cam-dpad-btn cam-dpad-up"
              onClick={() => { touchedTilt.current = true; const v = Math.min(89, tilt + 1); setTilt(v); void sendCamera(pan, v); }}>
              ↑
            </button>
            <div className="cam-dpad-middle">
              <button className="cam-dpad-btn cam-dpad-left"
                onClick={() => { touchedPan.current = true; const v = Math.max(-180, pan - 1); setPan(v); void sendCamera(v, tilt); }}>
                ←
              </button>
              <button className="cam-dpad-btn cam-dpad-center"
                onClick={() => { touchedPan.current = true; touchedTilt.current = true; setPan(0); setTilt(0); void sendCamera(0, 0); }}>
                ⊙
              </button>
              <button className="cam-dpad-btn cam-dpad-right"
                onClick={() => { touchedPan.current = true; const v = Math.min(180, pan + 1); setPan(v); void sendCamera(v, tilt); }}>
                →
              </button>
            </div>
            <button className="cam-dpad-btn cam-dpad-down"
              onClick={() => { touchedTilt.current = true; const v = Math.max(-89, tilt - 1); setTilt(v); void sendCamera(pan, v); }}>
              ↓
            </button>
          </div>

          <button className="btn-primary cam-apply-btn" onClick={handleManualCamera} disabled={camBusy}>
            {camBusy ? 'SENDING…' : 'APPLY ANGLES'}
          </button>
          <div className="cam-status-line">
            <span>SIM: {sim.simStatus.toUpperCase()}</span>
            <span>WS: {sim.wsStatus.toUpperCase()}</span>
          </div>
          {echoState === 'waiting' && lastCmd && (
            <div className="cam-echo cam-echo--waiting">
              SENT {lastCmd.pan.toFixed(1)}° / {lastCmd.tilt.toFixed(1)}° … WAITING FOR BACKEND ECHO
            </div>
          )}
          {echoState === 'confirmed' && lastCmd && (
            <div className="cam-echo cam-echo--ok">
              CONFIRMED {lastCmd.pan.toFixed(1)}° / {lastCmd.tilt.toFixed(1)}° — TELEMETRY + 3D UPDATED
            </div>
          )}
          {echoState === 'stale' && (
            <div className="cam-echo cam-echo--stale">
              BACKEND DID NOT ECHO — RESTART AI-SERVICE: uvicorn fsoc_main:app --port 8000
              {sim.wsStatus !== 'connected' && ' · WS DISCONNECTED, CHECK PROXY/BACKEND'}
            </div>
          )}
          {camError && <div className="cam-error">{camError}</div>}

          <div className="camera-sep" />

          {/* Virtual position indicator */}
          <div className="cam-pos-indicator">
            <div className="cam-pos-label">CAMERA POSITION</div>
            <div className="cam-pos-circle">
              <svg width="120" height="120" viewBox="-60 -60 120 120">
                <circle cx="0" cy="0" r="55" stroke="#242b30" strokeWidth="1" fill="none" />
                <circle cx="0" cy="0" r="37" stroke="#242b30" strokeWidth="1" fill="none" />
                <circle cx="0" cy="0" r="18" stroke="#242b30" strokeWidth="1" fill="none" />
                <line x1="-55" y1="0" x2="55" y2="0" stroke="#242b30" strokeWidth="0.5" />
                <line x1="0" y1="-55" x2="0" y2="55" stroke="#242b30" strokeWidth="0.5" />
                {/* hollow = commanded (sliders), filled = confirmed (telemetry) */}
                <circle
                  cx={normalize(pan, -180, 180) / 100 * 110 - 55}
                  cy={-(normalize(tilt, -90, 90) / 100 * 110 - 55)}
                  r="7"
                  fill="none"
                  stroke="#626a6d"
                  strokeWidth="1"
                  strokeDasharray="3 2"
                />
                <circle
                  cx={normalize(currentPan, -180, 180) / 100 * 110 - 55}
                  cy={-(normalize(currentTilt, -90, 90) / 100 * 110 - 55)}
                  r="5"
                  fill="#d98618"
                />
              </svg>
              <div className="cam-pos-labels">
                <span>CMD: {pan.toFixed(1)}° / {tilt.toFixed(1)}°</span>
                <span>PAN: {currentPan.toFixed(1)}°</span>
                <span>TILT: {currentTilt.toFixed(1)}°</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── Middle: charts ─────────────────────────────── */}
        <div className="camera-charts-col">
          <div className="chart-block">
            <div className="chart-title">Target Angle vs Camera Angle</div>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid stroke="#242b30" strokeDasharray="2 4" />
                <XAxis dataKey="i" tick={false} />
                <YAxis stroke="#3a464d" tick={{ fill: '#626a6d', fontSize: 10 }} />
                <Tooltip
                  contentStyle={{ background: '#0d1013', border: '1px solid #3a464d', fontSize: 11, borderRadius: 0 }}
                  labelStyle={{ color: '#8d9195' }}
                />
                <Legend wrapperStyle={{ fontSize: 10, color: '#8d9195' }} />
                <Line isAnimationActive={false} type="monotone" dataKey="pan"  stroke="#d98618" dot={false} strokeWidth={1.5} name="Pan" />
                <Line isAnimationActive={false} type="monotone" dataKey="tilt" stroke="#8d9195" dot={false} strokeWidth={1.5} name="Tilt" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="chart-block mt-4">
            <div className="chart-title">Control Error vs Time</div>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid stroke="#242b30" strokeDasharray="2 4" />
                <XAxis dataKey="i" tick={false} />
                <YAxis stroke="#3a464d" tick={{ fill: '#626a6d', fontSize: 10 }} />
                <Tooltip
                  contentStyle={{ background: '#0d1013', border: '1px solid #3a464d', fontSize: 11, borderRadius: 0 }}
                  labelStyle={{ color: '#8d9195' }}
                />
                <Legend wrapperStyle={{ fontSize: 10, color: '#8d9195' }} />
                <Line isAnimationActive={false} type="monotone" dataKey="panErr"  stroke="#f0b35a" dot={false} strokeWidth={1.5} name="Pan Error" />
                <Line isAnimationActive={false} type="monotone" dataKey="tiltErr" stroke="#8fa98f" dot={false} strokeWidth={1.5} name="Tilt Error" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* ── Right: PID config ──────────────────────────── */}
        <div className="camera-pid-col">
          <div className="pid-block">
            <div className="pid-title">PID CONFIGURATION</div>

            {[
              { key: 'kp',  label: 'Kp (Proportional)', min: 0, max: 10, step: 0.01 },
              { key: 'ki',  label: 'Ki (Integral)',      min: 0, max: 5,  step: 0.001 },
              { key: 'kd',  label: 'Kd (Derivative)',    min: 0, max: 5,  step: 0.01 },
              { key: 'max_angular_velocity', label: 'Max Velocity (°/s)', min: 1, max: 90, step: 0.5 },
              { key: 'settling_threshold',   label: 'Settling Threshold (°)', min: 0.05, max: 5, step: 0.05 },
            ].map(({ key, label, min, max, step }) => (
              <div key={key} className="pid-row">
                <label className="pid-label">{label}</label>
                <input
                  type="range"
                  min={min} max={max} step={step}
                  value={pid[key as keyof typeof pid]}
                  onChange={e => setPid(p => ({
                    ...p,
                    [key]: Number(e.target.value),
                  }))}
                  className="pid-slider"
                />
                <span className="pid-val">{(pid[key as keyof typeof pid] as number).toFixed(key === 'ki' ? 3 : 2)}</span>
              </div>
            ))}

            <button className="btn-primary pid-apply-btn" onClick={handlePIDApply}>
              APPLY PID
            </button>
          </div>

          {/* Current PID output */}
          <div className="pid-output-block">
            <div className="pid-title">PID OUTPUT</div>
            <div className="pid-out-row">
              <span className="pid-out-label">PAN CORRECTION</span>
              <span className="pid-out-val">{f?.pid_output?.pan_correction?.toFixed(5) ?? '—'} °</span>
            </div>
            <div className="pid-out-row">
              <span className="pid-out-label">TILT CORRECTION</span>
              <span className="pid-out-val">{f?.pid_output?.tilt_correction?.toFixed(5) ?? '—'} °</span>
            </div>
            <div className="pid-out-row">
              <span className="pid-out-label">SETTLED</span>
              <span className={`pid-out-val${f?.pid_output?.settled ? ' pid-settled' : ''}`}>
                {f?.pid_output?.settled ? 'YES' : 'NO'}
              </span>
            </div>
            <div className="pid-out-row">
              <span className="pid-out-label">PAN INTEGRAL</span>
              <span className="pid-out-val">{f?.pid_output?.pan_integral?.toFixed(3) ?? '—'}</span>
            </div>
            <div className="pid-out-row">
              <span className="pid-out-label">TILT INTEGRAL</span>
              <span className="pid-out-val">{f?.pid_output?.tilt_integral?.toFixed(3) ?? '—'}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
