/**
 * FSOC — Simulation Viewport
 * Lazy-loads the Three.js / R3F scene so the app works even if
 * three is not yet installed (fallback message is shown instead).
 */
import React, { Suspense, lazy } from 'react';
import type { TelemetryFrame } from '../../types/fsoc';

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
}

export function SimulationViewport({ frame, history }: Props) {
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
      }}
    >
      <Suspense
        fallback={
          <div className="sim3d-fallback">Loading 3-D engine…</div>
        }
      >
        <Scene3D frame={frame} history={history} />
      </Suspense>
    </div>
  );
}
