"""
FSOC Virtual PAT — Main FastAPI Application
Provides REST API + WebSocket for real-time simulation telemetry.

Run with:
    uvicorn fsoc_main:app --reload --port 8000
"""
import asyncio
import json
import time
from typing import Optional, Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, BackgroundTasks, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from simulation.engine import engine
from database import models as db
from reports.csv_report import generate_csv
from reports.json_report import generate_json
from reports.pdf_report import generate_pdf
from vision.video_processor import video_processor

# ── Boot DB ───────────────────────────────────────────────────
db.init_db()

# ── App ───────────────────────────────────────────────────────
app = FastAPI(
    title='FSOC Virtual PAT',
    description='AI-Assisted Coarse Alignment & Tracking Simulation API',
    version='1.0.0',
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

# ── WebSocket connection manager ──────────────────────────────

class ConnectionManager:
    def __init__(self):
        self._active: Set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._active.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self._active.discard(ws)

    async def broadcast(self, message: dict) -> None:
        dead = set()
        for ws in self._active:
            try:
                await ws.send_json(message)
            except Exception:
                dead.add(ws)
        self._active -= dead


manager = ConnectionManager()

# Register the broadcast function on both engine and video_processor
engine.set_broadcast(manager.broadcast)
video_processor.set_broadcast(manager.broadcast)


# ── Pydantic request models ───────────────────────────────────

class StartRequest(BaseModel):
    config: Optional[dict] = None
    demo_mode: bool = False


class DisturbanceUpdateRequest(BaseModel):
    atmospheric_turbulence: Optional[dict] = None
    platform_vibration: Optional[dict] = None
    camera_motion: Optional[dict] = None
    sensor_noise: Optional[dict] = None
    target_motion_variation: Optional[dict] = None


class PIDUpdateRequest(BaseModel):
    kp: float = Field(0.8, ge=0.0, le=10.0)
    ki: float = Field(0.05, ge=0.0, le=5.0)
    kd: float = Field(0.3, ge=0.0, le=5.0)
    max_angular_velocity: float = Field(15.0, ge=0.1, le=90.0)
    settling_threshold: float = Field(0.5, ge=0.01, le=5.0)


class CameraAngleRequest(BaseModel):
    pan: float = Field(0.0, ge=-180.0, le=180.0)
    tilt: float = Field(0.0, ge=-90.0, le=90.0)


class TargetOffsetRequest(BaseModel):
    x: float = Field(0.0, ge=-100.0, le=100.0)
    y: float = Field(0.0, ge=-100.0, le=100.0)
    z: float = Field(0.0, ge=-100.0, le=100.0)


class SwitchTargetRequest(BaseModel):
    target_id: str = "TARGET-01"
    position: Optional[dict] = None
    velocity: Optional[dict] = None
    trajectory: str = "static"
    beacon_offset: Optional[dict] = None


class ScenarioCreateRequest(BaseModel):
    name: str
    description: str = ''
    environment: str = 'urban'
    config: dict = Field(default_factory=dict)


# ── Simulation endpoints ──────────────────────────────────────

@app.post('/api/simulation/start')
async def start_simulation(req: StartRequest):
    run_id = await engine.start(config=req.config, demo_mode=req.demo_mode)
    return {'success': True, 'run_id': run_id, 'status': engine.status}


@app.post('/api/simulation/stop')
async def stop_simulation():
    await engine.stop()
    return {'success': True, 'status': engine.status}


@app.post('/api/simulation/pause')
async def pause_simulation():
    await engine.pause()
    return {'success': True, 'status': engine.status}


@app.post('/api/simulation/reset')
async def reset_simulation():
    await engine.reset()
    return {'success': True, 'status': engine.status}


@app.get('/api/simulation/status')
def get_status():
    return {
        'status': engine.status,
        'run_id': engine.run_id,
    }


# ── Configuration endpoints ───────────────────────────────────

@app.post('/api/simulation/disturbances')
def update_disturbances(req: DisturbanceUpdateRequest):
    engine.update_disturbances(req.dict(exclude_none=True))
    return {'success': True}


@app.post('/api/simulation/pid')
def update_pid(req: PIDUpdateRequest):
    engine.update_pid(req.dict())
    return {'success': True}


@app.post('/api/simulation/camera')
def update_camera(req: CameraAngleRequest):
    engine.update_camera_angles(req.pan, req.tilt)
    return {'success': True}


@app.post('/api/simulation/target_offset')
def update_target_offset(req: TargetOffsetRequest):
    """Shift the true beacon world position (e.g. operator moved TARGET-01
    in the 3D view). Flows through projection → feed → detection → PID."""
    engine.set_target_offset(req.x, req.y, req.z)
    return {'success': True}


@app.post('/api/simulation/switch_target')
def switch_target(req: SwitchTargetRequest):
    """Switch coarse-alignment tracking objective to another target entity."""
    engine.switch_target(
        target_id=req.target_id,
        position=req.position,
        velocity=req.velocity,
        trajectory=req.trajectory,
        beacon_offset=req.beacon_offset,
    )
    return {'success': True, 'target_id': req.target_id}


# ── Scenarios ─────────────────────────────────────────────────

@app.post('/api/scenarios')
def create_scenario(req: ScenarioCreateRequest):
    config = req.config or {}
    config.update({
        'name': req.name,
        'description': req.description,
        'environment': req.environment,
    })
    sid = db.save_scenario(config)
    return {'success': True, 'id': sid}


@app.get('/api/scenarios')
def list_scenarios():
    return {'success': True, 'data': db.list_scenarios()}


@app.get('/api/scenarios/{scenario_id}')
def get_scenario(scenario_id: str):
    s = db.get_scenario(scenario_id)
    if not s:
        raise HTTPException(404, 'Scenario not found')
    return {'success': True, 'data': s}


# ── Runs ──────────────────────────────────────────────────────

@app.get('/api/runs')
def list_runs():
    return {'success': True, 'data': db.list_runs()}


@app.get('/api/runs/{run_id}')
def get_run(run_id: str):
    r = db.get_run(run_id)
    if not r:
        raise HTTPException(404, 'Run not found')
    telemetry = db.get_telemetry(run_id, limit=2000)
    return {'success': True, 'data': r, 'telemetry': telemetry}


# ── Video input (Benchmark 2) ────────────────────────────

@app.post('/api/simulation/upload-video')
async def upload_video(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    """
    Accepts an MP4 video file and processes it through the tracking pipeline.
    The virtual PTZ camera is bypassed; frames are fed directly into the
    detection + Kalman + PID pipeline.  Results are streamed via WebSocket
    exactly like the virtual simulation.
    """
    import tempfile, os, shutil
    # Stop any running virtual simulation first
    if engine.status == 'running':
        await engine.stop()

    # Save upload to a temp file
    suffix = os.path.splitext(file.filename or 'video.mp4')[1] or '.mp4'
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        shutil.copyfileobj(file.file, tmp)
        tmp.close()
        tmp_path = tmp.name
    finally:
        file.file.close()

    # Schedule background processing
    orig_name = file.filename or 'uploaded_video.mp4'
    async def _run():
        try:
            run_id = await video_processor.process(tmp_path, scenario_name=f'VIDEO-{orig_name}')
        finally:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

    background_tasks.add_task(_run)
    # Return immediately; frontend connects via WebSocket for progress
    return {
        'success': True,
        'message': 'Video processing started',
        'run_id': None,  # will be emitted via WS once processing begins
        'filename': file.filename,
    }


# ── Reports ───────────────────────────────────────────────────

@app.get('/api/reports/{run_id}/csv')
def report_csv(run_id: str):
    content = generate_csv(run_id)
    return Response(
        content=content,
        media_type='text/csv',
        headers={'Content-Disposition': f'attachment; filename=fsoc_run_{run_id[:8]}.csv'},
    )


@app.get('/api/reports/{run_id}/json')
def report_json(run_id: str):
    content = generate_json(run_id)
    return Response(
        content=content,
        media_type='application/json',
        headers={'Content-Disposition': f'attachment; filename=fsoc_run_{run_id[:8]}.json'},
    )


@app.get('/api/reports/{run_id}/pdf')
def report_pdf(run_id: str):
    pdf_bytes = generate_pdf(run_id)
    return Response(
        content=pdf_bytes,
        media_type='application/pdf',
        headers={'Content-Disposition': f'attachment; filename=fsoc_run_{run_id[:8]}.pdf'},
    )


# ── WebSocket ─────────────────────────────────────────────────

@app.websocket('/ws/simulation')
async def websocket_endpoint(ws: WebSocket):
    await manager.connect(ws)
    try:
        # Send initial status
        await ws.send_json({
            'type': 'status',
            'payload': {'status': engine.status, 'run_id': engine.run_id},
        })
        # Keep alive — also listen for client control messages
        while True:
            try:
                data = await asyncio.wait_for(ws.receive_text(), timeout=30.0)
                msg = json.loads(data)
                # Handle client-initiated commands over WebSocket
                if msg.get('type') == 'ping':
                    await ws.send_json({'type': 'ping', 'payload': {'ts': time.time()}})
                elif msg.get('type') == 'disturbances':
                    engine.update_disturbances(msg.get('payload', {}))
            except asyncio.TimeoutError:
                # Send heartbeat
                await ws.send_json({'type': 'ping', 'payload': {'ts': time.time()}})
    except WebSocketDisconnect:
        manager.disconnect(ws)
    except Exception:
        manager.disconnect(ws)


# ── Health ────────────────────────────────────────────────────

@app.get('/api/health')
def health():
    return {
        'status': 'healthy',
        'service': 'fsoc-virtual-pat',
        'version': '1.0.0',
        'simulation_status': engine.status,
    }


@app.get('/')
def root():
    return {'service': 'FSOC Virtual PAT API', 'docs': '/docs'}
