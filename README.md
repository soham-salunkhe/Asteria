# ASTERIA — FSOC Virtual PAT

**AI-Assisted Virtual Camera Tracking System for Free Space Optical Communication (Coarse Alignment)**

> SEE · ACQUIRE · TRACK · ALIGN

---

## What is this?

Free Space Optical Communication (FSOC) uses laser beams to transmit data at gigabit-to-terabit rates between mobile platforms — satellites, UAVs, ground stations. Before communication can begin, both terminals must be precisely aligned. This coarse alignment stage is called **PAT** — Pointing, Acquisition & Tracking.

ASTERIA is a **complete software simulation** of the FSOC coarse PAT process: a virtual pan/tilt camera autonomously detects a moving optical beacon (classical CV + Kalman + PID closed loop), holds lock, and scores itself against PS169 thresholds — no hardware required. It also tracks beacons in uploaded MP4 videos (Benchmark-2 mode) and ships as a packaged desktop app.

---

## Run the packaged app (no setup)

1. Go to **Releases** on GitHub and download `ASTERIA-Setup-1.0.0.exe` (installer) or `ASTERIA-Portable-1.0.0.exe` (no install, runs from USB).
2. Launch it — the tracking engine starts automatically.
3. Click **START DEMO**: the camera slews onto the beacon, acquires in ~1 s, and holds `LOCKED` while error stays ≤ 10 px.

---

## The Tracking Pipeline

```
Virtual Environment / MP4 Video
        ↓
Moving Optical Beacon
        ↓
Virtual Camera (pan/tilt, 4°×3° FOV)
        ↓
Beacon Detection (adaptive classical CV)
        ↓
Kalman Filter (state estimation)
        ↓
Pixel Error + Feedforward
        ↓
PID Controller (pan/tilt correction)
        ↓
Camera Re-aims
        ↓
TARGET LOCKED (≤ 10 px held)
        ↓
Performance Analysis (PS169 report)
```

---

## Architecture

```
Asteria/
├── frontend/           React + TypeScript + Vite  (port 5173)
│   └── src/
│       ├── pages/      Mission, Tracking, Detection, Camera,
│       │               Analytics, Disturbances, Reports, Settings, Copilot
│       ├── components/ Simulation (3D twin), telemetry, layout
│       ├── hooks/      useSimulation (WebSocket + state)
│       ├── services/   fsocApi.ts, simulationWebSocket.ts
│       └── types/      fsoc.ts (all TypeScript interfaces)
│
├── backend/            Node.js + Express  (port 5001)
│   └── src/routes/
│       └── guideRoutes.ts   Gemini Engineering Copilot proxy
│
├── ai-service/         Python + FastAPI  (port 8000)
│   ├── fsoc_main.py    Main server — REST API + WebSocket
│   ├── simulation/     Engine, target, camera, disturbances
│   ├── prediction/     Kalman filter (real numpy implementation)
│   ├── control/        PID controller (dual-axis pan/tilt)
│   ├── vision/         Image detector + MP4 video processor
│   ├── analytics/      Metrics (acquisition, RMSE, retention, FPS)
│   ├── reports/        CSV / JSON / PDF report generation
│   └── database/       SQLite models (scenarios, runs, telemetry)
│
├── electron/           Desktop shell + local process supervision
├── docs/               Technical report + user manual (PDF)
└── release/            Packaged installer / portable builds
```

---

## Quick Start (developers)

### Prerequisites

- Python 3.11+
- Node.js 20+

### 1. Python tracking engine

```bash
cd ai-service
pip install -r requirements.txt
python -m uvicorn fsoc_main:app --reload --port 8000
```

### 2. Node.js backend (Gemini Copilot)

```bash
cd backend
npm install
npm run dev
```

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**

### Build the desktop app

```bash
npm run dist:all   # NSIS installer + portable EXE in release/
```

---

## Environment Variables

### `frontend/.env`

```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
VITE_FSOC_API_URL=http://localhost:8000
VITE_FSOC_WS_URL=ws://localhost:8000/ws/simulation
VITE_API_URL=http://localhost:5001/api
```

### `backend/.env`

```
PORT=5001
GEMINI_API_KEY=your_gemini_api_key_here
```

---

## Pages

| Page | URL | Description |
|------|-----|-------------|
| Mission Control | `/mission` | Home — 3D twin, START DEMO, live metrics |
| Live Tracking | `/tracking` | 2D camera feed + full telemetry sidebar |
| Detection | `/detection` | CV pipeline visualization, candidates, confidence |
| Camera Control | `/camera` | Manual pan/tilt, PID parameter tuning, charts |
| Disturbance Lab | `/disturbances` | Turbulence, vibration, noise — live impact charts |
| Analytics | `/analytics` | Telemetry charts (error, FPS, confidence, lock) |
| Reports | `/reports` | Run history, CSV / JSON / PDF export |
| Settings | `/settings` | All system parameters |
| Gemini Copilot | `/copilot` | AI engineering analysis with live telemetry context |

---

## Simulation Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| Target trajectory | Sinusoidal | linear / sinusoidal / circular / figure_8 / random_walk / spiral |
| Amplitude H | 90 m | Horizontal oscillation range |
| Amplitude V | 45 m | Vertical oscillation range |
| Period | 18 s | One full oscillation |
| Camera FOV | 4° × 3° | PS169 optical field of view |
| Sensor | 640 × 480 @ 30 Hz | Fixed PS169 baseline |
| Beacon | Square, 10 px | Shape square/circle, size 5–20 px |
| Gimbal limit | 5°/s | Pan/tilt max rate (configurable 1–15) |

---

## Performance Metrics (PS169)

| Metric | Requirement | Description |
|--------|-------------|-------------|
| Acquisition Time | ≤ 2 s | First detection → first lock |
| Average Tracking Error | ≤ 10 px | Mean centroid residual |
| RMSE Tracking Error | ≤ 10 px | Full-run root-mean-square |
| Lock Retention | > 95% | % of eligible frames locked |
| Target Loss | < 5% | Frames without measurement |
| Re-acquisition | ≤ 1 s | Loss → tracking again |
| Processing Speed | ≥ 20 FPS | Sustained throughput |
| Processing Latency | ≤ 50 ms | Per-frame compute time |

Reports include per-frame lock-retention diagnostics (eligible/locked/unlocked counts plus loss reasons).

---

## Detector Notes

Detection is classical computer vision (adaptive threshold → connected components → photometric scoring → temporal association) with a `DetectorInterface` abstraction. A `YOLODetector` adapter exists as an integration point, but there are no trained beacon weights in the repo — the operational path is the classical detector. See `docs/ASTERIA_FSOC_Technical_Report_FINAL.pdf` for the full technical treatment.

---

## Docs

- `docs/ASTERIA_FSOC_Technical_Report_FINAL.pdf` — 15-page technical report
- `docs/ASTERIA_User_Manual.pdf` — operator manual with screenshots

---

## License

Built for the FSOC PAT software simulation challenge (SIH / ISRO problem statement).
