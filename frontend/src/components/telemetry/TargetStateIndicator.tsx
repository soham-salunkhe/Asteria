/**
 * FSOC — Target State Indicator
 * Visual indicator for the current target acquisition / tracking state.
 */
import React from 'react';
import type { TargetState } from '../../types/fsoc';

const STATE_CONFIG: Record<TargetState, { label: string; color: string; pulse: boolean }> = {
  READY:       { label: 'READY',          color: '#6b7f80', pulse: false },
  SEARCHING:   { label: 'SEARCHING…',     color: '#e0a040', pulse: true  },
  DETECTED:    { label: 'DETECTED',       color: '#5fb3c0', pulse: false },
  ACQUIRING:   { label: 'ACQUIRING…',     color: '#5fb3c0', pulse: true  },
  TRACKING:    { label: 'TRACKING',       color: '#4caf82', pulse: false },
  LOCKED:      { label: 'TARGET LOCKED',  color: '#4caf82', pulse: false },
  LOST:        { label: 'TARGET LOST',    color: '#c05050', pulse: true  },
  REACQUIRING: { label: 'REACQUIRING…',   color: '#e0a040', pulse: true  },
  ERROR:       { label: 'ERROR',          color: '#c05050', pulse: false },
};

interface Props {
  state: TargetState;
  large?: boolean;
}

export function TargetStateIndicator({ state, large = false }: Props) {
  const cfg = STATE_CONFIG[state] ?? STATE_CONFIG.READY;
  return (
    <div className={`state-indicator${large ? ' state-indicator--large' : ''}`}>
      <div
        className={`state-dot${cfg.pulse ? ' state-dot--pulse' : ''}`}
        style={{ background: cfg.color, boxShadow: `0 0 6px ${cfg.color}80` }}
      />
      <span className="state-label" style={{ color: cfg.color }}>{cfg.label}</span>
    </div>
  );
}
