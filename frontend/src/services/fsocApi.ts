/**
 * FSOC Virtual PAT — REST API Client
 * In development, Vite proxies /api/simulation, /api/runs etc. to localhost:8000.
 * In production, set VITE_FSOC_API_URL to the deployed backend URL.
 */

const FSOC_API = import.meta.env.VITE_FSOC_API_URL ?? '';

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${FSOC_API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${FSOC_API}${path}`);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

// ── Simulation ────────────────────────────────────────────────

export const fsocApi = {
  // Simulation control
  startSimulation: (config?: unknown, demoMode = false) =>
    post<{ success: boolean; run_id: string }>('/api/simulation/start', {
      config,
      demo_mode: demoMode,
    }),

  stopSimulation: () => post('/api/simulation/stop'),
  pauseSimulation: () => post('/api/simulation/pause'),
  resetSimulation: () => post('/api/simulation/reset'),

  getStatus: () =>
    get<{ status: string; run_id: string | null }>('/api/simulation/status'),

  // Configuration
  updateDisturbances: (config: unknown) =>
    post('/api/simulation/disturbances', config),

  updatePID: (config: unknown) =>
    post('/api/simulation/pid', config),

  updateKalman: (config: unknown) =>
    post('/api/simulation/kalman', config),

  setAtmosphere: (mode: string, strength: number) =>
    post<{ success: boolean; mode: string; strength: number }>('/api/simulation/atmosphere', { mode, strength }),

  updateCamera: (pan: number, tilt: number) =>
    post('/api/simulation/camera', { pan, tilt }),

  // Operator target shift (3D move → true beacon position → loop)
  setTargetOffset: (x: number, y: number, z: number) =>
    post('/api/simulation/target_offset', { x, y, z }),

  // Target switching (coarse-alignment objective switch)
  switchTarget: (data: {
    target_id: string;
    position?: { x: number; y: number; z: number };
    velocity?: { x: number; y: number; z: number };
    trajectory?: string;
    beacon_offset?: { x: number; y: number; z: number };
  }) => post<{ success: boolean; target_id: string }>('/api/simulation/switch_target', data),

  // Force reacquisition for the current target from any state (including LOST)
  reacquire: () =>
    post<{ success: boolean; target_id: string }>('/api/simulation/reacquire'),

  // Entity registration
  registerTarget: (targetId: string, config?: unknown) =>
    post<{ success: boolean; target_id: string; beacon_id: string }>('/api/simulation/register_target', { target_id: targetId, config }),

  registerCamera: (cameraId: string, config?: unknown) =>
    post<{ success: boolean; camera_id: string }>('/api/simulation/register_camera', { camera_id: cameraId, config }),

  registerSatellite: (satelliteId: string, cameraId: string) =>
    post<{ success: boolean; satellite_id: string; camera_id: string }>('/api/simulation/register_satellite', { satellite_id: satelliteId, camera_id: cameraId }),

  getEntityRegistry: () =>
    get<{ targets: string[]; cameras: string[]; satellites: string[]; active_target: string | null; active_camera: string | null }>('/api/simulation/entity_registry'),

  // Scenarios
  createScenario: (data: unknown) => post('/api/scenarios', data),
  listScenarios: () => get<{ data: unknown[] }>('/api/scenarios'),
  getScenario: (id: string) => get(`/api/scenarios/${id}`),

  // Runs
  listRuns: () => get<{ data: unknown[] }>('/api/runs'),
  getRun: (id: string) => get(`/api/runs/${id}`),

  // Reports (download URLs)
  reportUrl: (runId: string, format: 'csv' | 'json' | 'pdf') =>
    `${FSOC_API}/api/reports/${runId}/${format}`,

  // Health
  health: () => get('/api/health'),
};
