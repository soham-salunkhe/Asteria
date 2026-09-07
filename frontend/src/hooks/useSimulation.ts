/**
 * FSOC — useSimulation hook
 * Provides simulation state, latest telemetry, event log,
 * and control actions to any component.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import type { TelemetryFrame, EventLogEntry } from '../types/fsoc';
import { simulationWS } from '../services/simulationWebSocket';
import { fsocApi } from '../services/fsocApi';

const MAX_HISTORY = 600;   // ~20s at 30fps
const MAX_EVENTS  = 200;

export type WsStatus = 'connected' | 'disconnected' | 'error';

export function useSimulation() {
  const [wsStatus, setWsStatus] = useState<WsStatus>('disconnected');
  const [latest, setLatest]     = useState<TelemetryFrame | null>(null);
  const [history, setHistory]   = useState<TelemetryFrame[]>([]);
  const [events, setEvents]     = useState<EventLogEntry[]>([]);

  // Throttle history updates to avoid excess re-renders
  const historyBuffer = useRef<TelemetryFrame[]>([]);
  const flushTimer    = useRef<ReturnType<typeof setInterval> | null>(null);

  // Connect on mount
  useEffect(() => {
    simulationWS.connect(
      (frame) => {
        setLatest(frame);
        // Buffer history, flush every 250 ms
        historyBuffer.current.push(frame);
        // Collect events
        if (frame.events?.length) {
          setEvents(prev => {
            const combined = [...prev, ...frame.events];
            return combined.slice(-MAX_EVENTS);
          });
        }
      },
      (status) => setWsStatus(status),
    );

    flushTimer.current = setInterval(() => {
      if (historyBuffer.current.length === 0) return;
      const buf = historyBuffer.current.splice(0);
      setHistory(prev => {
        const combined = [...prev, ...buf];
        return combined.slice(-MAX_HISTORY);
      });
    }, 250);

    return () => {
      simulationWS.disconnect();
      if (flushTimer.current) clearInterval(flushTimer.current);
    };
  }, []);

  // ── Control actions ────────────────────────────────────────

  const startDemo = useCallback(async () => {
    await fsocApi.startSimulation(undefined, true);
  }, []);

  const startCustom = useCallback(async (config?: unknown) => {
    await fsocApi.startSimulation(config, false);
  }, []);

  const stop  = useCallback(() => fsocApi.stopSimulation(), []);
  const pause = useCallback(() => fsocApi.pauseSimulation(), []);
  const reset = useCallback(() => fsocApi.resetSimulation(), []);

  const updateDisturbances = useCallback((cfg: unknown) =>
    fsocApi.updateDisturbances(cfg), []);

  const updatePID = useCallback((cfg: unknown) =>
    fsocApi.updatePID(cfg), []);

  const updateCamera = useCallback((pan: number, tilt: number) =>
    fsocApi.updateCamera(pan, tilt), []);

  return {
    wsStatus,
    latest,
    history,
    events,
    // convenience aliases
    simStatus: latest?.sim_status ?? 'idle',
    targetState: latest?.target_state ?? 'READY',
    // actions
    startDemo,
    startCustom,
    stop,
    pause,
    reset,
    updateDisturbances,
    updatePID,
    updateCamera,
  };
}
