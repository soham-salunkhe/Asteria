/**
 * FSOC — Real-time Event Log
 * Displays timestamped system events streamed from the simulation engine.
 */
import React, { useRef, useEffect } from 'react';
import type { EventLogEntry } from '../../types/fsoc';

const LEVEL_COLOR: Record<string, string> = {
  info:    '#5fb3c0',
  success: '#4caf82',
  warning: '#e0a040',
  error:   '#c05050',
};

interface Props {
  events: EventLogEntry[];
  maxHeight?: number;
}

export function EventLog({ events, maxHeight = 240 }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  return (
    <div className="event-log" style={{ maxHeight }}>
      {events.length === 0 ? (
        <span className="event-log-empty">Awaiting simulation events…</span>
      ) : (
        events.map((e) => (
          <div key={e.id} className="event-row">
            <span className="event-ts">
              {new Date(e.timestamp * 1000).toLocaleTimeString('en-GB', { hour12: false })}
            </span>
            <span className="event-msg" style={{ color: LEVEL_COLOR[e.level] ?? '#8a9ba0' }}>
              {e.message}
            </span>
          </div>
        ))
      )}
      <div ref={bottomRef} />
    </div>
  );
}
