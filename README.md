# FSOC Virtual PAT

**AI-Assisted Virtual Camera Tracking System for Free Space Optical Communication**

> SEE · ACQUIRE · TRACK · ALIGN

---

## What is this?

Free Space Optical Communication (FSOC) uses laser beams to transmit data at gigabit-to-terabit rates between mobile platforms — satellites, UAVs, ground stations. Before communication can begin, both terminals must be precisely aligned. This coarse alignment stage is called **PAT** — Pointing, Acquisition & Tracking.

This project is a **complete software simulation** of the FSOC coarse PAT process, allowing algorithm development and testing without expensive hardware.

---

## The Tracking Pipeline

```
Virtual Environment
       ↓
Moving Optical Beacon
       ↓
Virtual Camera (pan/tilt)
       ↓
Image Processing
       ↓
AI Beacon Detection (Mock / YOLO)
       ↓
Kalman Filter (state estimation)
       ↓
Angular Error Calculation
       ↓
PID Controller (pan/tilt correction)
       ↓
Camera Re-aims
       ↓
TARGET LOCKED
       ↓
Performance Analysis
```

---

## Architecture

```
MICHIRA-main/
├── frontend/           React + TypeScript + Vite  (port 5173)
│   └── src/
│       ├── pages/      9 FSOC application pages
│       ├── components/ Simulation, telemetry, layout components
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
│   ├── simulation/     Environment, target, camera, disturbances
│   ├── prediction/     Kalman filter (real numpy implementation)
│   ├── control/        PID controller (dual-axis pan/tilt)
│   ├── vision/         Detector abstraction — Mock + YOLO-ready
│   ├── analytics/      Performance metrics accumulator
│   ├── reports/        CSV / JSON / PDF report generation
│   └── database/       SQLite models (scenarios, runs, telemetry)
│
└── database/
    └── README.md       SQLite auto-created at ai-service/fsoc_pat.db
```

---

## Quick Start

### Prerequisites

- Python 3.11+
- Node.js 20+

### 1. Python simulation engine

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
| Mission Control | `/mission` | Home — START DEMO, target config, live metrics |
| Live Tracking | `/tracking` | Hero screen — camera feed + full telemetry sidebar |
| Detection | `/detection` | CV pipeline visualization, bounding box, confidence |
| Camera Control | `/camera` | Manual pan/tilt, PID parameter tuning, charts |
| Disturbance Lab | `/disturbances` | Turbulence, vibration, noise — live impact charts |
| Analytics | `/analytics` | 6 scientific telemetry charts |
| Reports | `/reports` | Run history, CSV / JSON / PDF export |
| Settings | `/settings` | All system parameters |
| Gemini Copilot | `/copilot` | AI engineering analysis with live telemetry context |

---

## Simulation Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| Target trajectory | Sinusoidal | linear / sinusoidal / circular / random_walk |
| Amplitude H | 90 m | Horizontal oscillation range |
| Amplitude V | 45 m | Vertical oscillation range |
| Period | 18 s | One full oscillation |
| Camera FOV H | 28° | Horizontal field of view |
| Camera FOV V | 21° | Vertical field of view |
| FPS | 30 | Simulation frame rate |
| Kalman Q | 0.5 | Process noise covariance |
| Kalman R | 5.0 | Measurement noise covariance |
| PID Kp | 0.8 | Proportional gain |
| PID Ki | 0.05 | Integral gain |
| PID Kd | 0.3 | Derivative gain |

---

## Performance Metrics

| Metric | Description |
|--------|-------------|
| Acquisition Time | Seconds from start to first stable track |
| Average Angular Error | Mean pointing error in degrees |
| Maximum Angular Error | Worst-case pointing error |
| Lock Retention | % of time target was locked |
| FPS | Simulation frames per second |
| Processing Latency | Per-frame computation time (ms) |
| Detection Confidence | Mean detector confidence (0–1) |

---

## YOLO Integration

The detector is designed for drop-in YOLO replacement:

```
DetectorInterface (abstract)
       ↓
┌──────────────────┐
│                  │
MockDetector    YOLODetector
│                  │
└────────┬─────────┘
         ↓
   DetectionResult
```

To connect a real YOLO model:
1. Train a model on optical beacon imagery
2. Place weights at `ai-service/models/beacon_yolo.pt`
3. Install ultralytics: `pip install ultralytics`
4. In `fsoc_main.py`, change `create_detector(use_yolo=False)` to `create_detector(use_yolo=True)`

---

## License

Built for the FSOC PAT software simulation challenge.
