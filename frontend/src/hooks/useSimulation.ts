/**
 * FSOC — useSimulation hook
 * Provides simulation state, latest telemetry, event log,
 * and control actions to any component.
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { TelemetryFrame, EventLogEntry, DisturbanceConfig } from '../types/fsoc';
import { simulationWS } from '../services/simulationWebSocket';
import { fsocApi } from '../services/fsocApi';

const MAX_HISTORY = 120;   // ~4s at 30fps — avoids memory bloat while preserving smooth charts
const MAX_EVENTS  = 100;

export type WsStatus = 'connected' | 'disconnected' | 'error';

// ── Authoritative frontend mirror of the backend disturbance config ──
// Single source of truth for ALL pages (Disturbance Lab, Mission, …).
// Lives in the app-root SimulationProvider, so it survives navigation.
// The backend engine is the ultimate authority; telemetry frames echo its
// config back and reconcile this mirror (covers refresh-while-running).
export const DEFAULT_DISTURBANCES: DisturbanceConfig = {
  atmospheric_turbulence:  { enabled: false, strength: 0.3,  frequency: 2.0 },
  platform_vibration:      { enabled: false, amplitude: 0.5, frequency: 10.0 },
  camera_motion:           { enabled: false, angular_disturbance: 0.1 },
  sensor_noise:            { enabled: false, noise_level: 0.05, noise_type: 'gaussian' },
  target_motion_variation: { enabled: false, velocity_variation: 0.3 },
};

function normalizeDisturbances(cfg: Partial<DisturbanceConfig> | null | undefined): DisturbanceConfig {
  const d = DEFAULT_DISTURBANCES;
  const pick = <T>(v: T | undefined, fb: T): T => (v === undefined || v === null ? fb : v);
  return {
    atmospheric_turbulence: {
      enabled:   pick(cfg?.atmospheric_turbulence?.enabled, d.atmospheric_turbulence.enabled),
      strength:  pick(cfg?.atmospheric_turbulence?.strength, d.atmospheric_turbulence.strength),
      frequency: pick(cfg?.atmospheric_turbulence?.frequency, d.atmospheric_turbulence.frequency),
    },
    platform_vibration: {
      enabled:   pick(cfg?.platform_vibration?.enabled, d.platform_vibration.enabled),
      amplitude: pick(cfg?.platform_vibration?.amplitude, d.platform_vibration.amplitude),
      frequency: pick(cfg?.platform_vibration?.frequency, d.platform_vibration.frequency),
    },
    camera_motion: {
      enabled:             pick(cfg?.camera_motion?.enabled, d.camera_motion.enabled),
      angular_disturbance: pick(cfg?.camera_motion?.angular_disturbance, d.camera_motion.angular_disturbance),
    },
    sensor_noise: {
      enabled:     pick(cfg?.sensor_noise?.enabled, d.sensor_noise.enabled),
      noise_level: pick(cfg?.sensor_noise?.noise_level, d.sensor_noise.noise_level),
      noise_type:  pick(cfg?.sensor_noise?.noise_type, d.sensor_noise.noise_type),
    },
    target_motion_variation: {
      enabled:            pick(cfg?.target_motion_variation?.enabled, d.target_motion_variation.enabled),
      velocity_variation: pick(cfg?.target_motion_variation?.velocity_variation, d.target_motion_variation.velocity_variation),
    },
  };
}

function sameDisturbances(a: DisturbanceConfig, b: DisturbanceConfig): boolean {
  const keys = [
    'atmospheric_turbulence', 'platform_vibration', 'camera_motion',
    'sensor_noise', 'target_motion_variation',
  ] as const;
  return keys.every(k => {
    const x = a[k] as unknown as Record<string, unknown>;
    const y = (b[k] ?? {}) as unknown as Record<string, unknown>;
    return Object.keys(x).every(f => x[f] === y[f]);
  });
}

function useSimulationState() {
  const [wsStatus, setWsStatus] = useState<WsStatus>('disconnected');
  const [latest, setLatest]     = useState<TelemetryFrame | null>(null);
  const [history, setHistory]   = useState<TelemetryFrame[]>([]);
  const [events, setEvents]     = useState<EventLogEntry[]>([]);
  // Authoritative disturbance config — shared by every page, survives
  // navigation because this hook lives in the app-root provider.
  const [disturbances, setDisturbancesState] =
    useState<DisturbanceConfig>(DEFAULT_DISTURBANCES);

  // Throttle history updates to avoid excess re-renders
  const historyBuffer = useRef<TelemetryFrame[]>([]);
  const flushTimer    = useRef<ReturnType<typeof setInterval> | null>(null);
  // Status override from REST after control actions (stop/pause/reset).
  // Needed because the backend loop exits on STOP, so no fresh telemetry
  // arrives and `latest.sim_status` would otherwise stay frozen at 'running'.
  // Cleared as soon as any live telemetry frame arrives.
  const [statusOverride, setStatusOverride] = useState<string | null>(null);

  // Connect on mount
  useEffect(() => {
    simulationWS.connect(
      (frame) => {
        setLatest(frame);
        setStatusOverride(null);
        // Reconcile the authoritative disturbance mirror with the backend
        // echo. No-op when identical (avoids extra renders at 30 fps).
        const echoed = frame.disturbance?.config;
        if (echoed) {
          const norm = normalizeDisturbances(echoed);
          setDisturbancesState(prev => (sameDisturbances(prev, norm) ? prev : norm));
        }
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

  // Re-read authoritative status after a control action. Used by
  // stop/pause/reset where the WS stream may go quiet (no new frames).
  const refreshStatus = useCallback(async (fallback: string) => {
    try {
      const s = await fsocApi.getStatus();
      setStatusOverride(s.status);
    } catch {
      setStatusOverride(fallback);
    }
  }, []);

  const startDemo = useCallback(async () => {
    await fsocApi.startSimulation(undefined, true);
    setStatusOverride(null); // fresh telemetry will confirm 'running'
  }, []);

  const startCustom = useCallback(async (config?: unknown) => {
    await fsocApi.startSimulation(config, false);
    setStatusOverride(null); // fresh telemetry will confirm 'running'
  }, []);

  const stop = useCallback(async () => {
    await fsocApi.stopSimulation();
    await refreshStatus('stopped');
  }, [refreshStatus]);
  const pause = useCallback(async () => {
    await fsocApi.pauseSimulation();
    await refreshStatus('paused');
  }, [refreshStatus]);
  const reset = useCallback(async () => {
    await fsocApi.resetSimulation();
    await refreshStatus('idle');
  }, [refreshStatus]);

  // Write-through update: mirror locally first (instant UI feedback,
  // survives navigation), then push to the backend engine. The next
  // telemetry frame echoes the applied config back for confirmation.
  const updateDisturbanceConfig = useCallback(async (cfg: DisturbanceConfig) => {
    const norm = normalizeDisturbances(cfg);
    setDisturbancesState(norm);
    await fsocApi.updateDisturbances(norm);
  }, []);

  // Legacy fire-and-forget sender (kept for compatibility).
  const updateDisturbances = useCallback((cfg: unknown) =>
    fsocApi.updateDisturbances(cfg), []);

  const updatePID = useCallback((cfg: unknown) =>
    fsocApi.updatePID(cfg), []);

  const updateCamera = useCallback((pan: number, tilt: number) =>
    fsocApi.updateCamera(pan, tilt), []);

  const setTargetOffset = useCallback((x: number, y: number, z: number) =>
    fsocApi.setTargetOffset(x, y, z), []);

  const switchTarget = useCallback((data: {
    target_id: string;
    position?: { x: number; y: number; z: number };
    velocity?: { x: number; y: number; z: number };
    trajectory?: string;
    beacon_offset?: { x: number; y: number; z: number };
  }) => fsocApi.switchTarget(data), []);

  return {
    wsStatus,
    latest,
    history,
    events,
    // authoritative disturbance state (single source of truth)
    disturbances,
    // convenience aliases (REST override wins until live telemetry resumes)
    simStatus: statusOverride ?? latest?.sim_status ?? 'idle',
    targetState: latest?.target_state ?? 'READY',
    // actions
    startDemo,
    startCustom,
    stop,
    pause,
    reset,
    updateDisturbanceConfig,
    updateDisturbances,
    updatePID,
    updateCamera,
    setTargetOffset,
    switchTarget,
  };
}

type SimulationContextValue = ReturnType<typeof useSimulationState>;

const SimulationContext = createContext<SimulationContextValue | null>(null);

/** Keeps one telemetry connection and one shared state for the entire app. */
export function SimulationProvider({ children }: { children: ReactNode }) {
  const simulation = useSimulationState();
  return createElement(SimulationContext.Provider, { value: simulation }, children);
}

export function useSimulation(): SimulationContextValue {
  const simulation = useContext(SimulationContext);
  if (!simulation) {
    throw new Error('useSimulation must be used inside <SimulationProvider>');
  }
  return simulation;
}
