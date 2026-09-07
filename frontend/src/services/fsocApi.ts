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

  updateCamera: (pan: number, tilt: number) =>
    post('/api/simulation/camera', { pan, tilt }),

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
