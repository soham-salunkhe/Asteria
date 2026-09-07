/**
 * FSOC — Detection Page
 * Computer-vision pipeline analysis view.
 * Shows detection results, bounding box, confidence, pipeline stages.
 */
import React from 'react';
import { useSimulation } from '../../hooks/useSimulation';
import { CameraFeed } from '../../components/simulation/CameraFeed';
import { TelemetryPanel } from '../../components/telemetry/TelemetryPanel';

const PIPELINE_STAGES = [
  'INPUT FRAME',
  'NOISE REDUCTION',
  'CONTRAST ENHANCE',
  'YOLO / MOCK DETECTOR',
  'CONFIDENCE FILTER',
  'POSITION ESTIMATION',
  'KALMAN UPDATE',
];

export function DetectionPage() {
  const sim = useSimulation();
  const f   = sim.latest;
  const det = f?.detection;
  const kal = f?.kalman;
  const met = f?.metrics;

  const activeStage = det ? 6 : f ? 1 : 0;

  return (
    <div className="page-detection">
      <div className="page-header">
        <h2 className="page-title">Detection</h2>
        <span className="page-subtitle">Computer Vision Pipeline</span>
      </div>

      <div className="detection-body">
        {/* ── Camera feed ────────────────────────────────── */}
        <div className="detection-feed-col">
          <div className="detection-feed-label">INPUT / DETECTION FRAME</div>
          <CameraFeed frame={f} width={640} height={480} />

          <div className="detection-bb-info">
            {det ? (
              <>
                <span className="bb-label">BOUNDING BOX</span>
                <span className="bb-val">
                  x={det.bounding_box.x.toFixed(0)}
                  {' '}y={det.bounding_box.y.toFixed(0)}
                  {' '}w={det.bounding_box.width.toFixed(0)}
                  {' '}h={det.bounding_box.height.toFixed(0)}
                </span>
                <span className="bb-label ml-4">CENTROID</span>
                <span className="bb-val">
                  ({det.centroid.x.toFixed(1)}, {det.centroid.y.toFixed(1)})
                </span>
              </>
            ) : (
              <span className="bb-empty">No detection this frame</span>
            )}
          </div>
        </div>

        {/* ── Pipeline + stats ───────────────────────────── */}
        <div className="detection-info-col">

          {/* Pipeline diagram */}
          <div className="pipeline-block">
            <div className="pipeline-title">DETECTION PIPELINE</div>
            {PIPELINE_STAGES.map((stage, i) => {
              const isActive  = i === activeStage;
              const isDone    = i < activeStage;
              const cls = isActive ? 'pipe-stage pipe-stage--active'
                        : isDone   ? 'pipe-stage pipe-stage--done'
                        : 'pipe-stage';
              return (
                <div key={stage} className={cls}>
                  <div className="pipe-dot" />
                  <span className="pipe-label">{stage}</span>
                  {isDone && <span className="pipe-ok">✓</span>}
                  {isActive && <span className="pipe-spin">◌</span>}
                  {i < PIPELINE_STAGES.length - 1 && (
                    <div className="pipe-connector" />
                  )}
                </div>
              );
            })}
          </div>

          <div className="detection-sep" />

          {/* Detection metrics */}
          <TelemetryPanel
            title="DETECTION RESULT"
            fields={[
              { label: 'STATUS',      value: det ? 'DETECTED' : 'NOT DETECTED', highlight: !!det, warn: !det },
              { label: 'TARGET ID',   value: det?.target_id ?? '—' },
              { label: 'CLASS',       value: det?.class ?? '—' },
              { label: 'CONFIDENCE',  value: det ? `${(det.confidence * 100).toFixed(2)}%` : '—', highlight: (det?.confidence ?? 0) > 0.9 },
              { label: 'INFERENCE',   value: det ? `${det.inference_ms.toFixed(2)} ms` : '—' },
              { label: 'DETECTOR',    value: det?.detector?.toUpperCase() ?? '—', dim: true },
            ]}
          />

          <div className="detection-sep" />

          <TelemetryPanel
            title="KALMAN ESTIMATE"
            fields={[
              { label: 'EST POSITION', value: kal ? `(${kal.position.x.toFixed(1)}, ${kal.position.y.toFixed(1)})` : '—' },
              { label: 'EST VELOCITY', value: kal ? `(${kal.velocity?.x?.toFixed(2) ?? '—'}, ${kal.velocity?.y?.toFixed(2) ?? '—'})` : '—' },
              { label: 'PRED POSITION', value: kal?.predicted_position ? `(${kal.predicted_position.x.toFixed(1)}, ${kal.predicted_position.y.toFixed(1)})` : '—' },
              { label: 'UNCERTAINTY',   value: kal ? kal.uncertainty.toFixed(2) : '—' },
              { label: 'CONVERGED',     value: kal ? (kal.converged ? 'YES' : 'NO') : '—', highlight: kal?.converged },
            ]}
          />

          <div className="detection-sep" />

          {/* Running stats */}
          <TelemetryPanel
            title="RUN STATISTICS"
            fields={[
              { label: 'AVG CONFIDENCE', value: met?.detection_confidence !== undefined ? `${(met.detection_confidence * 100).toFixed(1)}%` : '—' },
              { label: 'PROCESSING',     value: met?.processing_ms !== undefined ? `${met.processing_ms.toFixed(2)} ms` : '—' },
              { label: 'FPS',            value: met?.fps?.toFixed(1) ?? '—' },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
