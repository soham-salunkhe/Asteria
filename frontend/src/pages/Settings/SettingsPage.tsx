/**
 * FSOC — Settings Page
 */
import React, { useState } from 'react';

interface SettingsSection {
  title: string;
  items: { key: string; label: string; type: 'text' | 'number' | 'select' | 'toggle'; value: string | number | boolean; options?: string[] }[];
}

export function SettingsPage() {
  const [settings, setSettings] = useState({
    // Simulation
    fps: 30,
    resolution: '640x480',
    simDt: 0.033,

    // Camera
    fovH: 28.0,
    fovV: 21.0,
    noiseLevel: 0.02,

    // Detection
    useYolo: false,
    modelPath: 'models/beacon_yolo.pt',
    confThreshold: 0.5,

    // Kalman
    processNoiseQ: 0.5,
    measurementNoiseR: 5.0,
    initialCovariance: 500.0,

    // PID
    kp: 0.8,
    ki: 0.05,
    kd: 0.3,
    maxVelocity: 15.0,
    settlingThreshold: 0.5,

    // Gemini
    geminiModel: 'gemini-1.5-flash',

    // Performance
    historyMaxFrames: 600,
    telemetrySampleEvery: 5,
  });

  const set = (key: string, val: string | number | boolean) =>
    setSettings(s => ({ ...s, [key]: val }));

  return (
    <div className="page-settings">
      <div className="page-header">
        <h2 className="page-title">Settings</h2>
        <span className="page-subtitle">System Configuration</span>
      </div>

      <div className="settings-body">

        <SettingsGroup title="SIMULATION">
          <NumberSetting label="Target FPS"             value={settings.fps}    onChange={v => set('fps', v)} min={5} max={120} step={1} />
          <NumberSetting label="Simulation Δt (s)"      value={settings.simDt} onChange={v => set('simDt', v)} min={0.005} max={0.1} step={0.001} />
          <SelectSetting label="Camera Resolution"      value={settings.resolution} options={['320x240','640x480','1280x720','1920x1080']} onChange={v => set('resolution', v)} />
        </SettingsGroup>

        <SettingsGroup title="CAMERA">
          <NumberSetting label="FOV Horizontal (°)"     value={settings.fovH}   onChange={v => set('fovH', v)} min={5} max={90} step={0.5} />
          <NumberSetting label="FOV Vertical (°)"       value={settings.fovV}   onChange={v => set('fovV', v)} min={5} max={60} step={0.5} />
          <NumberSetting label="Noise Level (0-1)"      value={settings.noiseLevel} onChange={v => set('noiseLevel', v)} min={0} max={1} step={0.005} />
        </SettingsGroup>

        <SettingsGroup title="DETECTION">
          <ToggleSetting label="Use YOLO Model (requires model file)" value={settings.useYolo} onChange={v => set('useYolo', v)} />
          <TextSetting   label="Model Path"                          value={settings.modelPath as string} onChange={v => set('modelPath', v)} />
          <NumberSetting label="Confidence Threshold"                value={settings.confThreshold} onChange={v => set('confThreshold', v)} min={0.1} max={1.0} step={0.01} />
        </SettingsGroup>

        <SettingsGroup title="KALMAN FILTER">
          <NumberSetting label="Process Noise Q"          value={settings.processNoiseQ}        onChange={v => set('processNoiseQ', v)} min={0.01} max={50} step={0.01} />
          <NumberSetting label="Measurement Noise R"      value={settings.measurementNoiseR}     onChange={v => set('measurementNoiseR', v)} min={0.1} max={200} step={0.1} />
          <NumberSetting label="Initial Covariance"       value={settings.initialCovariance}     onChange={v => set('initialCovariance', v)} min={10} max={5000} step={10} />
        </SettingsGroup>

        <SettingsGroup title="PID CONTROLLER">
          <NumberSetting label="Kp"                        value={settings.kp}   onChange={v => set('kp', v)} min={0} max={10} step={0.01} />
          <NumberSetting label="Ki"                        value={settings.ki}   onChange={v => set('ki', v)} min={0} max={5} step={0.001} />
          <NumberSetting label="Kd"                        value={settings.kd}   onChange={v => set('kd', v)} min={0} max={5} step={0.01} />
          <NumberSetting label="Max Angular Velocity (°/s)"value={settings.maxVelocity}         onChange={v => set('maxVelocity', v)} min={1} max={90} step={0.5} />
          <NumberSetting label="Settling Threshold (°)"    value={settings.settlingThreshold}    onChange={v => set('settlingThreshold', v)} min={0.05} max={5} step={0.05} />
        </SettingsGroup>

        <SettingsGroup title="AI / GEMINI COPILOT">
          <SelectSetting label="Gemini Model" value={settings.geminiModel} options={['gemini-1.5-flash','gemini-1.5-pro','gemini-2.0-flash']} onChange={v => set('geminiModel', v)} />
        </SettingsGroup>

        <SettingsGroup title="PERFORMANCE">
          <NumberSetting label="History Buffer (frames)"        value={settings.historyMaxFrames}       onChange={v => set('historyMaxFrames', v)} min={60} max={3600} step={60} />
          <NumberSetting label="DB Telemetry Sample Rate"       value={settings.telemetrySampleEvery}   onChange={v => set('telemetrySampleEvery', v)} min={1} max={30} step={1} />
        </SettingsGroup>

        <div className="settings-note">
          Note: Changes to backend parameters (Kalman, PID, detection) take effect on the next simulation start.
          Frontend-only changes (history buffer, charts) apply immediately.
        </div>
      </div>
    </div>
  );
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="settings-group">
      <div className="settings-group-title">{title}</div>
      <div className="settings-group-body">{children}</div>
    </div>
  );
}

function NumberSetting({ label, value, onChange, min, max, step }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <div className="setting-row">
      <label className="setting-label">{label}</label>
      <div className="setting-input-group">
        <input
          type="range"
          min={min} max={max} step={step}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          className="setting-slider"
        />
        <input
          type="number"
          min={min} max={max} step={step}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          className="setting-number-input"
        />
      </div>
    </div>
  );
}

function SelectSetting({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <div className="setting-row">
      <label className="setting-label">{label}</label>
      <select className="setting-select" value={value} onChange={e => onChange(e.target.value)}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

function TextSetting({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="setting-row">
      <label className="setting-label">{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        className="setting-text-input"
      />
    </div>
  );
}

function ToggleSetting({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="setting-row">
      <label className="setting-label">{label}</label>
      <button
        className={`toggle-btn${value ? ' toggle-btn--on' : ''}`}
        onClick={() => onChange(!value)}
      >
        <div className="toggle-thumb" />
      </button>
    </div>
  );
}
