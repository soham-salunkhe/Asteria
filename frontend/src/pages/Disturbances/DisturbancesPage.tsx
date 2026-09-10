/**
 * FSOC — Disturbance Lab
 * Configures and activates disturbances in real time.
 */
import React, { useState, useEffect } from 'react';
import { useSimulation } from '../../hooks/useSimulation';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import type { TelemetryFrame } from '../../types/fsoc';

const CHART_WINDOW = 200;

interface DisturbanceState {
  atmospheric_turbulence: { enabled: boolean; strength: number; frequency: number };
  platform_vibration:     { enabled: boolean; amplitude: number; frequency: number };
  camera_motion:          { enabled: boolean; angular_disturbance: number };
  sensor_noise:           { enabled: boolean; noise_level: number; noise_type: string };
  target_motion_variation:{ enabled: boolean; velocity_variation: number };
}

const DEFAULT_DIST: DisturbanceState = {
  atmospheric_turbulence:  { enabled: false, strength: 0.3,  frequency: 2.0 },
  platform_vibration:      { enabled: false, amplitude: 0.5, frequency: 10.0 },
  camera_motion:           { enabled: false, angular_disturbance: 0.1 },
  sensor_noise:            { enabled: false, noise_level: 0.05, noise_type: 'gaussian' },
  target_motion_variation: { enabled: false, velocity_variation: 0.3 },
};

export function DisturbancesPage() {
  const sim = useSimulation();
  const f   = sim.latest;
  const [dist, setDist] = useState<DisturbanceState>(DEFAULT_DIST);

  const totalIndex = f?.disturbance?.total_disturbance_index ?? 0;
  const activeCount = f?.disturbance?.active_count ?? 0;

  const applyDisturbances = async (updated: DisturbanceState) => {
    await sim.updateDisturbances(updated);
  };

  const toggle = async (key: keyof DisturbanceState) => {
    const updated = {
      ...dist,
      [key]: { ...dist[key], enabled: !dist[key].enabled },
    };
    setDist(updated);
    await applyDisturbances(updated);
  };

  const setParam = async (
    key: keyof DisturbanceState,
    param: string,
    value: number | string,
  ) => {
    const updated = {
      ...dist,
      [key]: { ...dist[key], [param]: value },
    };
    setDist(updated);
    await applyDisturbances(updated);
  };

  // Chart
  const chartData = sim.history.slice(-CHART_WINDOW).map((fr: TelemetryFrame, i: number) => ({
    i,
    error: fr.angular_error.total_error,
    disturbance: (fr.disturbance?.total_disturbance_index ?? 0) * 5,
  }));

  return (
    <div className="page-disturbances">
      <div className="page-header">
        <h2 className="page-title">Disturbance Lab</h2>
        <span className="page-subtitle">Experiment Control — Active Disturbances: {activeCount}</span>
      </div>

      {/* ── Total disturbance index ───────────────────────── */}
      <div className="disturbance-index-row">
        <div className="di-label">TOTAL DISTURBANCE INDEX</div>
        <div className="di-bar-track">
          <div
            className="di-bar-fill"
            style={{
              width: `${totalIndex * 100}%`,
              background: totalIndex > 0.6 ? '#a86a5a'
                        : totalIndex > 0.3 ? '#e39a32'
                        : '#8fa98f',
            }}
          />
        </div>
        <div className="di-val">{(totalIndex * 100).toFixed(1)}%</div>
      </div>

      <div className="disturbances-body">
        {/* ── Controls ─────────────────────────────────────── */}
        <div className="dist-controls-col">

          {/* Atmospheric Turbulence */}
          <DisturbanceBlock
            title="ATMOSPHERIC TURBULENCE"
            desc="Simulates Cn² atmospheric scintillation and thermal wavefront distortion."
            enabled={dist.atmospheric_turbulence.enabled}
            onToggle={() => toggle('atmospheric_turbulence')}
          >
            <SliderParam
              label="Strength" min={0} max={1} step={0.01}
              value={dist.atmospheric_turbulence.strength}
              onChange={v => setParam('atmospheric_turbulence', 'strength', v)}
            />
            <SliderParam
              label="Frequency (Hz)" min={0.1} max={20} step={0.1}
              value={dist.atmospheric_turbulence.frequency}
              onChange={v => setParam('atmospheric_turbulence', 'frequency', v)}
            />
          </DisturbanceBlock>

          {/* Platform Vibration */}
          <DisturbanceBlock
            title="PLATFORM VIBRATION"
            desc="Structural vibration from UAV rotors, motors, or wind loading."
            enabled={dist.platform_vibration.enabled}
            onToggle={() => toggle('platform_vibration')}
          >
            <SliderParam
              label="Amplitude (°)" min={0.05} max={5} step={0.05}
              value={dist.platform_vibration.amplitude}
              onChange={v => setParam('platform_vibration', 'amplitude', v)}
            />
            <SliderParam
              label="Frequency (Hz)" min={1} max={50} step={0.5}
              value={dist.platform_vibration.frequency}
              onChange={v => setParam('platform_vibration', 'frequency', v)}
            />
          </DisturbanceBlock>

          {/* Camera Motion */}
          <DisturbanceBlock
            title="CAMERA MOTION"
            desc="Random angular jitter from gimbal play or mount instability."
            enabled={dist.camera_motion.enabled}
            onToggle={() => toggle('camera_motion')}
          >
            <SliderParam
              label="Angular Disturbance (°/frame)" min={0.01} max={2} step={0.01}
              value={dist.camera_motion.angular_disturbance}
              onChange={v => setParam('camera_motion', 'angular_disturbance', v)}
            />
          </DisturbanceBlock>

          {/* Sensor Noise */}
          <DisturbanceBlock
            title="SENSOR NOISE"
            desc="Image sensor thermal noise, read noise, and shot noise — applied to the camera image."
            enabled={dist.sensor_noise.enabled}
            onToggle={() => toggle('sensor_noise')}
          >
            <SliderParam
              label="Noise Level" min={0} max={1} step={0.01}
              value={dist.sensor_noise.noise_level}
              onChange={v => setParam('sensor_noise', 'noise_level', v)}
            />
            <div className="dist-param-row">
              <span className="dist-param-label">Noise Type</span>
              <span style={{ display: 'flex', gap: 4 }}>
                {(['gaussian', 'salt_pepper', 'poisson'] as const).map(nt => (
                  <button
                    key={nt}
                    className={`vp-btn vp-btn--sm${dist.sensor_noise.noise_type === nt ? ' vp-btn--active' : ''}`}
                    onClick={() => setParam('sensor_noise', 'noise_type', nt)}
                    title={nt}
                  >
                    {nt === 'gaussian' ? 'GAUSS' : nt === 'salt_pepper' ? 'S&P' : 'POISS'}
                  </button>
                ))}
              </span>
            </div>
          </DisturbanceBlock>

          {/* Target Motion Variation */}
          <DisturbanceBlock
            title="TARGET MOTION VARIATION"
            desc="Stochastic acceleration of the beacon — unpredictable manoeuvres."
            enabled={dist.target_motion_variation.enabled}
            onToggle={() => toggle('target_motion_variation')}
          >
            <SliderParam
              label="Velocity Variation" min={0} max={1} step={0.01}
              value={dist.target_motion_variation.velocity_variation}
              onChange={v => setParam('target_motion_variation', 'velocity_variation', v)}
            />
          </DisturbanceBlock>

          {/* Reset all */}
          <button
            className="btn-ghost dist-reset-btn"
            onClick={async () => {
              setDist(DEFAULT_DIST);
              await applyDisturbances(DEFAULT_DIST);
            }}
          >
            DISABLE ALL DISTURBANCES
          </button>
        </div>

        {/* ── Live disturbance chart ────────────────────────── */}
        <div className="dist-chart-col">
          <div className="chart-block">
            <div className="chart-title">Tracking Error + Disturbance Index (last {CHART_WINDOW} frames)</div>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid stroke="#242b30" strokeDasharray="2 4" />
                <XAxis dataKey="i" tick={false} />
                <YAxis stroke="#3a464d" tick={{ fill: '#626a6d', fontSize: 10 }} />
                <Tooltip
                  contentStyle={{ background: '#0d1013', border: '1px solid #3a464d', fontSize: 11, borderRadius: 0 }}
                />
                <Line type="monotone" dataKey="error"       stroke="#f0b35a" dot={false} strokeWidth={1.5} name="Angular Error (°)" />
                <Line type="monotone" dataKey="disturbance" stroke="#8d9195" dot={false} strokeWidth={1}   name="Disturbance ×5" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Live disturbance readout */}
          <div className="dist-readout-block">
            <div className="dist-readout-title">CURRENT DISTURBANCE</div>
            <div className="dist-readout-row">
              <span className="dr-label">ΔPan Perturbation</span>
              <span className="dr-val">{f?.disturbance?.current_perturbation?.x?.toFixed(4) ?? '—'} °</span>
            </div>
            <div className="dist-readout-row">
              <span className="dr-label">ΔTilt Perturbation</span>
              <span className="dr-val">{f?.disturbance?.current_perturbation?.y?.toFixed(4) ?? '—'} °</span>
            </div>
            <div className="dist-readout-row">
              <span className="dr-label">Active Sources</span>
              <span className="dr-val">{activeCount} / 5</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────

function DisturbanceBlock({
  title, desc, enabled, onToggle, children,
}: {
  title: string; desc: string; enabled: boolean;
  onToggle: () => void; children?: React.ReactNode;
}) {
  return (
    <div className={`dist-block${enabled ? ' dist-block--active' : ''}`}>
      <div className="dist-block-header">
        <div className="dist-block-info">
          <span className="dist-block-title">{title}</span>
          <span className="dist-block-desc">{desc}</span>
        </div>
        <button
          className={`toggle-btn${enabled ? ' toggle-btn--on' : ''}`}
          onClick={onToggle}
          aria-label={enabled ? 'Disable' : 'Enable'}
        >
          <div className="toggle-thumb" />
        </button>
      </div>
      {enabled && <div className="dist-block-params">{children}</div>}
    </div>
  );
}

function SliderParam({
  label, min, max, step, value, onChange,
}: {
  label: string; min: number; max: number; step: number;
  value: number; onChange: (v: number) => void;
}) {
  return (
    <div className="dist-param-row">
      <span className="dist-param-label">{label}</span>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="dist-param-slider"
      />
      <span className="dist-param-val">{value.toFixed(step < 0.01 ? 3 : step < 0.1 ? 2 : 1)}</span>
    </div>
  );
}
