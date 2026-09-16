/**
 * FSOC — Simulation Viewport
 * Lazy-loads the Three.js / R3F scene so the app works even if
 * three is not yet installed (fallback message is shown instead).
 */
import React, { Suspense, lazy } from 'react';
import type { TelemetryFrame } from '../../types/fsoc';
import type { TwinApi } from './Scene3D';

const Scene3D = lazy(() =>
  import('./Scene3D').catch(() => ({
    default: () => (
      <div className="sim3d-fallback">
        3-D view: install Three.js with
        <code> npm install three @react-three/fiber @react-three/drei</code>
      </div>
    ),
  }))
);

interface Props {
  frame: TelemetryFrame | null;
  history: TelemetryFrame[];
  minimalChrome?: boolean;
  onTwinApi?: (api: TwinApi) => void;
  simStatus?: string; // Pass simulation status from parent
}

export function SimulationViewport({ frame, history, minimalChrome, onTwinApi, simStatus }: Props) {
  const isIdle = simStatus === 'idle' || simStatus === 'stopped' || !simStatus;
  
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        flex: 1,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        background: '#101a29',
        overflow: 'hidden',
      }}
    >
      <Suspense
        fallback={
          <div className="sim3d-fallback">Loading 3-D engine…</div>
        }
      >
        <Scene3D frame={frame} history={history} minimalChrome={minimalChrome} onTwinApi={onTwinApi} simStatus={simStatus} />
      </Suspense>
      
      {/* Blur overlay when simulation is idle */}
      {isIdle && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backdropFilter: 'blur(8px)',
            background: 'rgba(16, 26, 41, 0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'all',
            cursor: 'not-allowed',
            zIndex: 10,
          }}
        >
          <div
            style={{
              fontFamily: 'monospace',
              fontSize: 14,
              color: '#8ba79e',
              letterSpacing: '0.1em',
              textAlign: 'center',
              padding: '20px 30px',
              background: 'rgba(6, 12, 16, 0.85)',
              border: '1px solid rgba(139, 167, 158, 0.3)',
              borderRadius: 4,
              userSelect: 'none',
            }}
          >
            <div style={{ marginBottom: 8, opacity: 0.6 }}>⚠</div>
            <div>3D VIEW LOCKED</div>
            <div style={{ fontSize: 10, marginTop: 8, opacity: 0.7 }}>
              Click START DEMO to activate
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
