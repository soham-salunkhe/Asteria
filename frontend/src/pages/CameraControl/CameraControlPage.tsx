/**
 * FSOC — Camera Control Page
 * Pan/tilt manual control + PID parameter tuning.
 */
import React, { useState, useCallback } from 'react';
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

  const [pid, setPid] = useState({
    kp: 0.8, ki: 0.05, kd: 0.3,
    max_angular_velocity: 15.0,
    settling_threshold: 0.5,
  });

  const handleManualCamera = useCallback(async () => {
    await sim.updateCamera(pan, tilt);
  }, [pan, tilt, sim]);

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

  const normalize = (val: number, min: number, max: number) =>
    ((val - min) / (max - min)) * 100;

  return (
    <div className="page-camera">
      <div className="page-header">
        <h2 className="page-title">Camera Control</h2>
        <span className="page-subtitle">Pan · Tilt · PID Configuration</span>
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
                onChange={e => setPan(Number(e.target.value))}
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
              <span className="cam-axis-range">−90° → +90°</span>
              <span className="cam-axis-current">{currentTilt.toFixed(2)}°</span>
            </div>
            <div className="cam-slider-track">
              <span className="cam-slider-tick">−90°</span>
              <input
                type="range"
                min={-90} max={90} step={0.1}
                value={tilt}
                onChange={e => setTilt(Number(e.target.value))}
                className="cam-slider"
              />
              <span className="cam-slider-tick">+90°</span>
            </div>
            <div className="cam-slider-val">{tilt.toFixed(1)}°</div>
          </div>

          {/* D-pad controls */}
          <div className="cam-dpad">
            <button className="cam-dpad-btn cam-dpad-up"
              onClick={() => { const v = tilt + 1; setTilt(Math.min(90, v)); }}>
              ↑
            </button>
            <div className="cam-dpad-middle">
              <button className="cam-dpad-btn cam-dpad-left"
                onClick={() => { const v = pan - 1; setPan(Math.max(-180, v)); }}>
                ←
              </button>
              <button className="cam-dpad-btn cam-dpad-center"
                onClick={() => { setPan(0); setTilt(0); }}>
                ⊙
              </button>
              <button className="cam-dpad-btn cam-dpad-right"
                onClick={() => { const v = pan + 1; setPan(Math.min(180, v)); }}>
                →
              </button>
            </div>
            <button className="cam-dpad-btn cam-dpad-down"
              onClick={() => { const v = tilt - 1; setTilt(Math.max(-90, v)); }}>
              ↓
            </button>
          </div>

          <button className="btn-primary cam-apply-btn" onClick={handleManualCamera}>
            APPLY ANGLES
          </button>

          <div className="camera-sep" />

          {/* Virtual position indicator */}
          <div className="cam-pos-indicator">
            <div className="cam-pos-label">CAMERA POSITION</div>
            <div className="cam-pos-circle">
              <svg width="120" height="120" viewBox="-60 -60 120 120">
                <circle cx="0" cy="0" r="55" stroke="#1e2c2c" strokeWidth="1" fill="none" />
                <circle cx="0" cy="0" r="37" stroke="#1e2c2c" strokeWidth="1" fill="none" />
                <circle cx="0" cy="0" r="18" stroke="#1e2c2c" strokeWidth="1" fill="none" />
                <line x1="-55" y1="0" x2="55" y2="0" stroke="#1e2c2c" strokeWidth="0.5" />
                <line x1="0" y1="-55" x2="0" y2="55" stroke="#1e2c2c" strokeWidth="0.5" />
                <circle
                  cx={normalize(currentPan, -180, 180) / 100 * 110 - 55}
                  cy={-(normalize(currentTilt, -90, 90) / 100 * 110 - 55)}
                  r="5"
                  fill="#3ecfcf"
                />
              </svg>
              <div className="cam-pos-labels">
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
                <CartesianGrid stroke="#1a2a2a" strokeDasharray="2 4" />
                <XAxis dataKey="i" tick={false} />
                <YAxis stroke="#4a5a5a" tick={{ fill: '#6b7f80', fontSize: 10 }} />
                <Tooltip
                  contentStyle={{ background: '#0e1717', border: '1px solid #1e2c2c', fontSize: 11 }}
                  labelStyle={{ color: '#6b7f80' }}
                />
                <Legend wrapperStyle={{ fontSize: 10, color: '#6b7f80' }} />
                <Line type="monotone" dataKey="pan"  stroke="#3ecfcf" dot={false} strokeWidth={1.5} name="Pan" />
                <Line type="monotone" dataKey="tilt" stroke="#e0a040" dot={false} strokeWidth={1.5} name="Tilt" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="chart-block mt-4">
            <div className="chart-title">Control Error vs Time</div>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid stroke="#1a2a2a" strokeDasharray="2 4" />
                <XAxis dataKey="i" tick={false} />
                <YAxis stroke="#4a5a5a" tick={{ fill: '#6b7f80', fontSize: 10 }} />
                <Tooltip
                  contentStyle={{ background: '#0e1717', border: '1px solid #1e2c2c', fontSize: 11 }}
                  labelStyle={{ color: '#6b7f80' }}
                />
                <Legend wrapperStyle={{ fontSize: 10, color: '#6b7f80' }} />
                <Line type="monotone" dataKey="panErr"  stroke="#c05050" dot={false} strokeWidth={1.5} name="Pan Error" />
                <Line type="monotone" dataKey="tiltErr" stroke="#4caf82" dot={false} strokeWidth={1.5} name="Tilt Error" />
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
