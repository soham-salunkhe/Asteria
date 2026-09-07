/**
 * FSOC — Analytics Page
 * Scientific telemetry charts. All values from live simulation history.
 */
import React from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ScatterChart, Scatter, ReferenceLine, AreaChart, Area,
} from 'recharts';
import { useSimulation } from '../../hooks/useSimulation';
import { TelemetryPanel } from '../../components/telemetry/TelemetryPanel';
import type { TelemetryFrame } from '../../types/fsoc';

const W = 300;

export function AnalyticsPage() {
  const sim = useSimulation();
  const hist = sim.history;
  const f = sim.latest;
  const met = f?.metrics;

  // Downsample history for charts
  const step = Math.max(1, Math.floor(hist.length / W));
  const sampled = hist.filter((_, i) => i % step === 0);

  const errorData = sampled.map((fr, i) => ({
    t: i,
    error: fr.angular_error.total_error,
    panErr: fr.angular_error.pan_error,
    tiltErr: fr.angular_error.tilt_error,
  }));

  const fpsData = sampled.map((fr, i) => ({
    t: i,
    fps: fr.metrics?.fps ?? 0,
    proc: fr.metrics?.processing_ms ?? 0,
  }));

  const confData = sampled.map((fr, i) => ({
    t: i,
    conf: (fr.metrics?.detection_confidence ?? 0) * 100,
  }));

  const lockData = sampled.map((fr, i) => ({
    t: i,
    locked: fr.target_state === 'LOCKED' ? 1 : 0,
  }));

  const scatterData = sampled.map(fr => ({
    pan: fr.angular_error.pan_error,
    tilt: fr.angular_error.tilt_error,
  }));

  const chartProps = {
    margin: { top: 4, right: 4, left: -24, bottom: 0 },
  };
  const gridProps = { stroke: '#1a2a2a', strokeDasharray: '2 4' };
  const axisProps = { stroke: '#4a5a5a', tick: { fill: '#6b7f80', fontSize: 10 } };
  const ttProps = {
    contentStyle: { background: '#0e1717', border: '1px solid #1e2c2c', fontSize: 11 },
    labelStyle: { color: '#6b7f80' },
  };

  return (
    <div className="page-analytics">
      <div className="page-header">
        <h2 className="page-title">Analytics</h2>
        <span className="page-subtitle">Simulation Telemetry — {hist.length} frames</span>
      </div>

      {/* ── Summary row ───────────────────────────────────── */}
      <div className="analytics-summary-row">
        <TelemetryPanel
          title="RUN SUMMARY"
          fields={[
            { label: 'DURATION',     value: f ? `${f.elapsed.toFixed(1)} s` : '—' },
            { label: 'AVG FPS',      value: met?.fps?.toFixed(1) ?? '—' },
            { label: 'ACQ TIME',     value: met?.acquisition_time != null ? `${met.acquisition_time.toFixed(3)} s` : '—' },
            { label: 'AVG ERROR',    value: met?.average_error?.toFixed(4) ?? '—', unit: '°' },
            { label: 'MAX ERROR',    value: met?.max_error?.toFixed(4) ?? '—', unit: '°', warn: (met?.max_error ?? 0) > 3 },
            { label: 'LOCK RET',     value: met?.lock_retention?.toFixed(1) ?? '—', unit: '%', highlight: (met?.lock_retention ?? 0) > 95 },
            { label: 'PROC LATENCY', value: met?.processing_ms?.toFixed(2) ?? '—', unit: 'ms' },
            { label: 'CONFIDENCE',   value: met?.detection_confidence != null ? `${(met.detection_confidence * 100).toFixed(1)}%` : '—' },
          ]}
          columns={2}
        />
      </div>

      {/* ── Charts ────────────────────────────────────────── */}
      <div className="analytics-charts-grid">

        <ChartCard title="Angular Error vs Time (°)">
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={errorData} {...chartProps}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="t" tick={false} />
              <YAxis {...axisProps} />
              <Tooltip {...ttProps} />
              <Line type="monotone" dataKey="error"   stroke="#c05050" dot={false} strokeWidth={1.5} name="Total" />
              <Line type="monotone" dataKey="panErr"  stroke="#3ecfcf" dot={false} strokeWidth={1}   name="Pan" />
              <Line type="monotone" dataKey="tiltErr" stroke="#e0a040" dot={false} strokeWidth={1}   name="Tilt" />
              <ReferenceLine y={0.5} stroke="#4caf8240" strokeDasharray="4 4" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="FPS + Processing Latency">
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={fpsData} {...chartProps}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="t" tick={false} />
              <YAxis {...axisProps} />
              <Tooltip {...ttProps} />
              <Line type="monotone" dataKey="fps"  stroke="#4caf82" dot={false} strokeWidth={1.5} name="FPS" />
              <Line type="monotone" dataKey="proc" stroke="#e0a040" dot={false} strokeWidth={1}   name="Proc (ms)" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Detection Confidence (%)">
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={confData} {...chartProps}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="t" tick={false} />
              <YAxis {...axisProps} domain={[0, 100]} />
              <Tooltip {...ttProps} />
              <Area
                type="monotone" dataKey="conf" stroke="#3ecfcf"
                fill="#3ecfcf20" strokeWidth={1.5} name="Confidence %" />
              <ReferenceLine y={90} stroke="#4caf8240" strokeDasharray="4 4" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Lock State vs Time">
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={lockData} {...chartProps}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="t" tick={false} />
              <YAxis {...axisProps} domain={[0, 1.2]} ticks={[0, 1]} />
              <Tooltip {...ttProps} />
              <Area
                type="stepAfter" dataKey="locked" stroke="#4caf82"
                fill="#4caf8220" strokeWidth={1.5} name="Locked" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Pan Error vs Tilt Error">
          <ResponsiveContainer width="100%" height={200}>
            <ScatterChart {...chartProps}>
              <CartesianGrid {...gridProps} />
              <XAxis type="number" dataKey="pan"  {...axisProps} name="Pan (°)" />
              <YAxis type="number" dataKey="tilt" {...axisProps} name="Tilt (°)" />
              <Tooltip
                {...ttProps}
                cursor={{ stroke: '#3ecfcf40' }}
                content={({ payload }) => {
                  if (!payload?.length) return null;
                  const d = payload[0].payload;
                  return (
                    <div style={{ background: '#0e1717', border: '1px solid #1e2c2c', padding: '4px 8px', fontSize: 11, color: '#8a9ba0' }}>
                      Pan: {d.pan?.toFixed(3)}° | Tilt: {d.tilt?.toFixed(3)}°
                    </div>
                  );
                }}
              />
              <Scatter data={scatterData} fill="#3ecfcf" opacity={0.5} />
              <ReferenceLine x={0} stroke="#4a5a5a40" />
              <ReferenceLine y={0} stroke="#4a5a5a40" />
            </ScatterChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Error Distribution (last 300 frames)">
          {(() => {
            const recent = hist.slice(-300).map(fr => fr.angular_error.total_error);
            const bins = 20;
            const maxE = Math.max(...recent, 1);
            const binSize = maxE / bins;
            const counts = Array(bins).fill(0);
            recent.forEach(v => {
              const b = Math.min(Math.floor(v / binSize), bins - 1);
              counts[b]++;
            });
            const histData = counts.map((c, i) => ({
              bin: (i * binSize + binSize / 2).toFixed(2),
              count: c,
            }));
            return (
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={histData} {...chartProps}>
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="bin" tick={{ fill: '#6b7f80', fontSize: 9 }} />
                  <YAxis {...axisProps} />
                  <Tooltip {...ttProps} />
                  <Area type="monotone" dataKey="count" stroke="#5fb3c0" fill="#5fb3c020" strokeWidth={1.5} name="Count" />
                </AreaChart>
              </ResponsiveContainer>
            );
          })()}
        </ChartCard>

      </div>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="analytics-chart-card">
      <div className="chart-card-title">{title}</div>
      {children}
    </div>
  );
}
