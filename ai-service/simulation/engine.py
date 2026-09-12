"""
FSOC PAT — Simulation Engine
Runs the main simulation loop in a background asyncio task.

Loop (per frame):
  update_target()
  apply_disturbances()
  update_virtual_camera() ← disturbances applied to camera
  project_target() ← get pixel position
  detection = detector.detect(pixel_pos)
  kalman.update(detection) + kalman.predict()
  error = camera.angular_error_to_target()
  pid_output = pid.update(error)
  camera.apply_correction(pid_output)
  metrics.update(...)
  emit_telemetry(ws)
"""
import asyncio
import math
import time
import uuid
import random
from concurrent.futures import ThreadPoolExecutor
from typing import Optional, Callable, Awaitable

# Thread pool for offloading blocking I/O (SQLite writes) off the event loop
_DB_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix='fsoc-db')


def _safe_float(mapping, key: str, default: float) -> float:
    """Read a numeric field from an incoming payload dict.

    Never raises and never returns NaN/inf/None: malformed values
    (null from JSON, strings, NaN) fall back to `default`. Without this,
    a single bad value turns the whole REST call into an HTTP 500 and
    the TRACK TARGET request is silently dropped — the UI then keeps
    showing the previous target's (stale) state.
    """
    if not isinstance(mapping, dict):
        return default
    try:
        v = float(mapping.get(key, default))
    except (TypeError, ValueError):
        return default
    if not math.isfinite(v):
        return default
    return v

# Import authoritative PS169 tracking thresholds — shared with VideoProcessor
from tracking_constants import (
    TARGET_LOCK_THRESHOLD_PX as _TLT_PX,
    TARGET_UNLOCK_PX as _TUL_PX,
    LOCK_FRAMES_REQUIRED as _LFR,
    ACQUIRING_THRESHOLD_PX as _ACQ_PX,
    LOST_GRACE_SECONDS as _LGS,
    REACQUIRE_TIMEOUT_SECONDS as _RTS,
)

from simulation.environment import get_environment, EnvironmentType
from simulation.target import Target, TargetConfig, Vec3
from simulation.camera import Camera, CameraConfig
from simulation.disturbances import DisturbanceEngine, DisturbanceConfig
from prediction.kalman import KalmanFilter2D, KalmanConfig
from control.pid import PIDController, PIDConfig
from vision.detector import create_detector, DetectorInterface
from vision.frame_renderer import FrameRenderer
from analytics.metrics import RunMetrics
from database import models as db

# ── Default scenario configuration ───────────────────────────
# PS169 closed-loop defaults: narrow 4°x3° camera, 30 Hz, straight-line
# demo target that starts inside the FOV so acquisition is genuine.

DEFAULT_PID = PIDConfig(kp=6.0, ki=0.15, kd=0.6,
                        max_angular_velocity=5.0, settling_threshold=0.05)

DEFAULT_KALMAN = KalmanConfig(process_noise_q=2.0,
                               measurement_noise_r=5.0,
                               initial_covariance=500.0)

DEFAULT_TARGET = TargetConfig(
    id='TARGET-01',
    initial_position=Vec3(-8.0, 2.0, 350.0),
    velocity=Vec3(6.0, 0.3, 0.0),
    trajectory='linear',
    amplitude_h=90.0,
    amplitude_v=45.0,
    period=18.0,
    beacon_size_px=10.0,
    beacon_shape='square',
)

DEFAULT_CAMERA = CameraConfig(
    position=Vec3(0, 0, 0),
    fov_h=4.0,
    fov_v=3.0,
    resolution_w=640,
    resolution_h=480,
    fps=30.0,
    noise_level=0.02,
)


def _safe_save_telemetry(run_id: str, snapshot: dict, frame_id: int) -> None:
    """Runs in thread pool — keeps SQLite I/O off the asyncio event loop."""
    try:
        db.save_telemetry_sample(run_id, snapshot, frame_id)
    except Exception:
        pass  # non-fatal


# ── Target state machine ──────────────────────────────────────

STATES = ['READY', 'SEARCHING', 'DETECTED', 'ACQUIRING',
          'TRACKING', 'LOCKED', 'LOST', 'REACQUIRING', 'ERROR']


class SimulationEngine:
    """
    Self-contained FSOC coarse-PAT simulation engine.
    Creates one asyncio task per run; results are streamed via callback.
    """

    TARGET_LOCK_THRESHOLD_PX = _TLT_PX   # PS169: Tracking error ≤ 10 pixels
    TARGET_UNLOCK_PX = _TUL_PX
    LOCK_FRAMES_REQUIRED = _LFR          # stable frames before LOCKED
    ACQUIRING_THRESHOLD_PX = _ACQ_PX     # pixels — DETECTED→ACQUIRING boundary
    # Widened sweep so targets placed anywhere in ±60° are reachable
    SEARCH_SWEEP_AMP = 60.0              # degrees, SEARCHING sweep amplitude
    SEARCH_SWEEP_RATE = 0.18             # rad/s — covers full arc in ~5 s
    LOST_GRACE_SECONDS = _LGS
    REACQUIRE_TIMEOUT_SECONDS = _RTS

    def __init__(self):
        self._running = False
        self._paused = False
        self._stopped = False  # Explicit stopped state
        self._task: Optional[asyncio.Task] = None
        self._run_id: Optional[str] = None
        self._run_counter = 0  # Incremented on each new run for stale callback detection

        # Components
        self._env_type: EnvironmentType = 'urban'
        # Atmospheric optical path (haze/fog/rain/low_light) applied to the
        # actual NumPy detection frame in FrameRenderer — never frontend-only.
        self._atmos_mode: str = 'clear'
        self._atmos_strength: float = 0.0
        self._target = Target(DEFAULT_TARGET)
        self._target_offset = Vec3(0.0, 0.0, 0.0)  # operator-injected shift (3D move)
        self._secondary_target: Optional[Target] = None
        self._multi_target: bool = False
        self._camera = Camera(DEFAULT_CAMERA)
        self._disturbances = DisturbanceEngine()
        self._kalman = KalmanFilter2D(DEFAULT_KALMAN)
        self._pid = PIDController(DEFAULT_PID)
        self._detector: DetectorInterface = create_detector(use_yolo=False)
        self._renderer = FrameRenderer(
            width=DEFAULT_CAMERA.resolution_w,
            height=DEFAULT_CAMERA.resolution_h,
        )
        import numpy as np
        self._rng = np.random.default_rng()
        self._metrics = RunMetrics()

        # Entity registry for multi-target/satellite support
        self._targets: dict[str, Target] = {}  # target_id -> Target
        self._cameras: dict[str, Camera] = {}  # camera_id -> Camera
        self._satellites: dict[str, dict] = {}  # satellite_id -> {camera_id, ...}
        self._target_links: dict[str, dict] = {}  # target_id -> {satellite_id, camera_id, beacon_id}
        self._tracking_session_id = 0
        self._active_tracking_session: Optional[dict] = None
        
        # Register default entities
        self._install_default_entity_graph()

        # State
        self._target_state = 'READY'
        self._frame_id = 0
        self._elapsed = 0.0
        self._missed_frames = 0
        self._lock_count = 0
        self._search_t = 0.0
        # Expanding-sweep anchor: last-known pointing at episode start.
        self._search_pan0 = 0.0
        self._search_tilt0 = 0.0
        self._acq_started = False
        self._reacquire_start_time = 0.0  # Track when REACQUIRING started
        self._events: list[dict] = []
        self._lost_frames_threshold = 30
        # Coast horizon: ~1 s of Kalman prediction coast after a dropout
        # before the estimate is dropped and the search sweep takes over.
        self._coast_frames = 30

        # Demo-mode phase tracking
        self._demo_mode = False
        self._demo_phase = 0
        self._demo_phase_start = 0.0

        # Broadcast callback — set by WebSocket handler
        self._broadcast: Optional[Callable[[dict], Awaitable[None]]] = None

    # ── Public API ────────────────────────────────────────────

    def set_broadcast(self, fn: Callable[[dict], Awaitable[None]]) -> None:
        self._broadcast = fn

    def register_target(self, target_id: str, config: Optional[dict] = None) -> dict:
        """Register a new target with the backend engine.
        Returns the target configuration including beacon association.
        """
        tc = config or {}
        beacon_id = tc.get('beacon_id', f'BEACON-{target_id.split("-")[-1]}')
        entity_ids = self._entity_ids()
        if target_id in entity_ids:
            return {'success': False, 'error': f'Entity {target_id} already exists'}
        if beacon_id in entity_ids:
            return {'success': False, 'error': f'Entity {beacon_id} already exists'}
        
        # Create target with provided or default config
        bo = tc.get('beacon_offset', {'x': 0, 'y': 0, 'z': 0})
        if tc.get('random_init'):
            from simulation.target import random_initial_position
            _rp = random_initial_position(tc.get('seed')).as_dict()
            init_xyz = (_rp['x'], _rp['y'], _rp['z'])
        else:
            init_xyz = (float(tc.get('x', 0)), float(tc.get('y', 0)), float(tc.get('z', 350)))
        target = Target(TargetConfig(
            id=target_id,
            initial_position=Vec3(*init_xyz),
            velocity=Vec3(
                float(tc.get('vx', 0)),
                float(tc.get('vy', 0)),
                float(tc.get('vz', 0))
            ),
            trajectory=tc.get('trajectory', 'static'),
            intensity=float(tc.get('intensity', 0.95)),
            beacon_size_px=float(tc.get('beacon_size_px', 10.0)),
            beacon_shape=tc.get('beacon_shape', 'square'),
            beacon_offset=Vec3(float(bo.get('x', 0)), float(bo.get('y', 0)), float(bo.get('z', 0))),
            amplitude_h=float(tc.get('amplitude_h', 80.0)),
            amplitude_v=float(tc.get('amplitude_v', 40.0)),
            period=float(tc.get('period', 20.0)),
        ))
        
        self._targets[target_id] = target
        suffix = target_id.split('-')[-1]
        camera_id = tc.get('camera_id', 'FSOC-CAM-01')
        satellite_id = tc.get('satellite_id', 'SAT-01')
        self._target_links[target_id] = {
            'satellite_id': satellite_id,
            'camera_id': camera_id,
            'beacon_id': beacon_id,
        }
        self._emit_event('info', f'TARGET CREATED — {target_id}')
        
        return {
            'success': True,
            'target_id': target_id,
            **self._target_links[target_id],
        }

    def register_camera(self, camera_id: str, config: Optional[dict] = None) -> dict:
        """Register a new FSOC camera with the backend engine."""
        if camera_id in self._entity_ids():
            return {'success': False, 'error': f'Entity {camera_id} already exists'}
        
        cc = config or {}
        camera = Camera(CameraConfig(
            fov_h=cc.get('fov_h', 4.0),
            fov_v=cc.get('fov_v', 3.0),
            resolution_w=cc.get('resolution_w', 640),
            resolution_h=cc.get('resolution_h', 480),
            fps=cc.get('fps', 30.0),
            noise_level=cc.get('noise_level', 0.02),
        ))
        
        self._cameras[camera_id] = camera
        self._emit_event('info', f'CAMERA CREATED — {camera_id}')
        
        return {'success': True, 'camera_id': camera_id}

    def register_satellite(self, satellite_id: str, camera_id: str) -> dict:
        """Register a satellite with its associated FSOC camera."""
        if satellite_id in self._entity_ids():
            return {'success': False, 'error': f'Entity {satellite_id} already exists'}
        if camera_id == satellite_id or (camera_id in self._entity_ids() and camera_id not in self._cameras):
            return {'success': False, 'error': f'Camera ID {camera_id} conflicts with an existing entity'}
        
        if camera_id not in self._cameras:
            # Auto-create camera if it doesn't exist
            self.register_camera(camera_id)
        
        self._satellites[satellite_id] = {
            'camera_id': camera_id,
            'created_at': time.time(),
        }
        self._emit_event('info', f'SATELLITE CREATED — {satellite_id} → {camera_id}')
        
        return {'success': True, 'satellite_id': satellite_id, 'camera_id': camera_id}

    def _entity_ids(self) -> set[str]:
        """All IDs share one namespace; type collisions are invalid as duplicates."""
        return (
            set(self._targets)
            | set(self._cameras)
            | set(self._satellites)
            | {link['beacon_id'] for link in self._target_links.values()}
        )

    def get_entity_registry(self) -> dict:
        """Return the authoritative typed entity graph for every consumer."""
        # Resolve the active camera: find whichever registered satellite
        # owns the camera that is currently configured on self._camera.
        # Fall back to 'FSOC-CAM-01' if the registry hasn't been populated.
        active_camera = next(
            (sat['camera_id'] for sat in self._satellites.values()
             if sat.get('is_active')),
            next(iter(self._cameras), 'FSOC-CAM-01'),
        )
        entities: list[dict] = []
        for satellite_id, satellite in self._satellites.items():
            entities.append({
                'id': satellite_id, 'type': 'satellite', 'name': satellite_id,
                'cameraId': satellite['camera_id'],
            })
        for camera_id in self._cameras:
            host = next((sid for sid, sat in self._satellites.items()
                         if sat['camera_id'] == camera_id), None)
            entities.append({
                'id': camera_id, 'type': 'fsoc_camera', 'name': camera_id,
                'hostSatelliteId': host,
            })
        for target_id, link in self._target_links.items():
            entities.append({
                'id': target_id, 'type': 'target', 'name': target_id,
                'beaconId': link['beacon_id'], 'hostSatelliteId': link['satellite_id'],
            })
            entities.append({
                'id': link['beacon_id'], 'type': 'beacon', 'name': link['beacon_id'],
                'parentTargetId': target_id,
            })
        self._validate_entity_graph(entities)
        return {
            'targets': list(self._targets.keys()),
            'cameras': list(self._cameras.keys()),
            'satellites': list(self._satellites.keys()),
            'target_links': self._target_links,
            'entities': entities,
            'active_tracking_session': self._active_tracking_session,
            'active_target': self._target.config.id if self._target else None,
            'active_camera': active_camera,
        }

    @staticmethod
    def _validate_entity_graph(entities: list[dict]) -> None:
        """Development-time fail-fast diagnostics for relationship corruption."""
        by_id = {entity['id']: entity for entity in entities}
        if len(by_id) != len(entities):
            raise RuntimeError('[ASTERIA STATE ERROR] duplicate entity ID in registry')
        allowed = {'target', 'beacon', 'satellite', 'fsoc_camera'}
        for entity in entities:
            if entity.get('type') not in allowed:
                raise RuntimeError(f"[ASTERIA STATE ERROR] {entity['id']} has invalid type")
            if entity['type'] == 'target':
                beacon = by_id.get(entity.get('beaconId'))
                if not beacon or beacon.get('type') != 'beacon' or beacon.get('parentTargetId') != entity['id']:
                    raise RuntimeError(f"[ASTERIA STATE ERROR] invalid beacon relationship for {entity['id']}")
            if entity['type'] == 'satellite':
                camera = by_id.get(entity.get('cameraId'))
                if not camera or camera.get('hostSatelliteId') != entity['id']:
                    raise RuntimeError(f"[ASTERIA STATE ERROR] invalid camera relationship for {entity['id']}")

    async def start(self, config: Optional[dict] = None,
                    demo_mode: bool = False) -> str:
        if self._running:
            await self.stop()

        self._apply_config(config or {})
        self._reset_state()
        # A new run must never inherit the paused state of the previous one.
        self._paused = False
        self._stopped = False  # Reset stopped flag for new run
        self._run_counter += 1  # Increment run counter for stale callback detection
        self._demo_mode = demo_mode
        self._demo_phase = 0
        self._demo_phase_start = 0.0

        # Create run record in DB
        self._run_id = db.create_run(
            scenario_id=None,
            scenario_name=config.get('name', 'FSOC-DEMO-042') if config else 'FSOC-DEMO-042',
            env=self._env_type,
        )

        self._running = True
        self._task = asyncio.create_task(self._loop())
        self._emit_event('info', 'SIMULATION STARTED')
        tc = self._target.config
        self._emit_event('info',
                         f'TARGET CREATED — {tc.id} · {tc.trajectory.upper()} · '
                         f'BEACON {tc.beacon_shape.upper()} {tc.beacon_size_px:.0f}px')
        self._emit_event('info', 'TARGET MOTION STARTED')
        self._target_state = 'SEARCHING'
        self._emit_event('info', 'SEARCHING FOR BEACON…')
        return self._run_id

    async def stop(self) -> None:
        self._running = False
        self._stopped = True  # Set explicit stopped state
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        # Send final telemetry frame with stopped status before finalizing
        await self._send_stop_telemetry()
        self._finalize_run('aborted')
        self._emit_event('warning', 'SIMULATION STOPPED')

    async def _send_stop_telemetry(self, scenario_reset: bool = False) -> None:
        """Send a final, non-destructive scene snapshot when tracking stops."""
        if not self._broadcast:
            return
        try:
            now = time.time()
            target_snapshots = []
            for target_id, target in self._targets.items():
                link = self._target_links.get(target_id, {})
                snapshot = target.state_dict(now)
                snapshot['image_position'] = None
                snapshot['is_primary'] = target is self._target
                snapshot['entity'] = {
                    'id': target_id, 'type': 'target',
                    'beaconId': link.get('beacon_id'),
                    'hostSatelliteId': link.get('satellite_id'),
                }
                snapshot['beacon'] = {
                    'id': link.get('beacon_id'), 'type': 'beacon',
                    'parentTargetId': target_id,
                    'size_px': target.config.beacon_size_px,
                    'shape': target.config.beacon_shape,
                    'intensity': target.config.intensity,
                }
                target_snapshots.append(snapshot)
            active_snapshot = next(
                (snapshot for snapshot in target_snapshots if snapshot['is_primary']),
                target_snapshots[0] if target_snapshots else None,
            )
            telemetry = {
                'type': 'telemetry',
                'payload': {
                    'timestamp': now,
                    'frame_id': self._frame_id,
                    'elapsed': round(self._elapsed, 3),
                    'sim_status': 'idle' if scenario_reset else 'stopped',
                    'scenario_reset': scenario_reset,
                    'source': 'virtual',
                    'target_state': 'IDLE',
                    # STOP terminates control loops, not scene entities.
                    'target': active_snapshot,
                    'targets': target_snapshots,
                    'tracking_session': self._active_tracking_session,
                    'centroiding_error': {},
                    'pixel_error': {},
                    'target_offset': self._target_offset.as_dict(),
                    'camera': self._camera.state_dict(now),
                    'detection': None,
                    'kalman': None,
                    'angular_error': {'pan_error': 0.0, 'tilt_error': 0.0, 'total_error': 0.0},
                    'pid_output': {},
                    'disturbance': {},
                    'metrics': {},
                    'events': [{'id': str(uuid.uuid4()), 'timestamp': now, 'level': 'warning', 'message': 'SIMULATION STOPPED'}],
                },
            }
            await self._broadcast(telemetry)
        except Exception:
            pass

    async def pause(self) -> None:
        self._paused = not self._paused
        label = 'SIMULATION PAUSED' if self._paused else 'SIMULATION RESUMED'
        self._emit_event('info', label)

    async def reset(self) -> None:
        await self.stop()
        self._reset_state()
        self._stopped = False  # Reset stopped flag after reset

    async def end_demo(self) -> None:
        """End the runtime scenario and restore only the clean default graph.

        Unlike stop(), this deliberately discards dynamically registered
        targets, beacons, satellites, cameras and the active tracking session.
        """
        await self.stop()
        self._target = Target(DEFAULT_TARGET)
        self._camera = Camera(DEFAULT_CAMERA)
        self._targets = {}
        self._cameras = {}
        self._satellites = {}
        self._target_links = {}
        self._install_default_entity_graph()
        self._secondary_target = None
        self._active_tracking_session = None
        self._tracking_session_id = 0
        self._run_id = None
        self._stopped = False
        self._reset_state()
        self._emit_event('info', 'DEMO ENDED — RUNTIME SCENARIO CLEARED')
        await self._send_stop_telemetry(scenario_reset=True)

    def _install_default_entity_graph(self) -> None:
        """Install fresh default objects; no mutable runtime objects are reused."""
        self._targets[DEFAULT_TARGET.id] = self._target
        self._cameras['FSOC-CAM-01'] = self._camera
        self._satellites['SAT-01'] = {
            'camera_id': 'FSOC-CAM-01', 'created_at': time.time(), 'is_active': True,
        }
        self._target_links[DEFAULT_TARGET.id] = {
            'satellite_id': 'SAT-01', 'camera_id': 'FSOC-CAM-01', 'beacon_id': 'BEACON-01',
        }

    # Disturbance sections in stable order: (config key, label)
    DISTURBANCE_SECTIONS = (
        ('atmospheric_turbulence', 'ATMOSPHERIC TURBULENCE'),
        ('platform_vibration', 'PLATFORM VIBRATION'),
        ('camera_motion', 'CAMERA MOTION'),
        ('sensor_noise', 'SENSOR NOISE'),
        ('target_motion_variation', 'TARGET MOTION VARIATION'),
    )

    def update_disturbances(self, config: dict) -> None:
        prev = {
            key: bool(getattr(self._disturbances.config, key).enabled)
            for key, _ in self.DISTURBANCE_SECTIONS
        }
        dc = self._dict_to_disturbance_config(config or {})
        self._disturbances.update_config(dc)
        # Emit one event per disturbance whose enabled flag actually changed,
        # so the event log reflects authoritative state transitions only.
        changed = False
        for key, label in self.DISTURBANCE_SECTIONS:
            now = bool(getattr(dc, key).enabled)
            if now and not prev[key]:
                self._emit_event('info', f'{label} ENABLED')
                changed = True
            elif not now and prev[key]:
                self._emit_event('info', f'{label} DISABLED')
                changed = True
        if not changed:
            active = [label for key, label in self.DISTURBANCE_SECTIONS
                      if getattr(dc, key).enabled]
            if active:
                self._emit_event('info',
                                 f'DISTURBANCES UPDATED — {", ".join(active)}')
            else:
                self._emit_event('info', 'ALL DISTURBANCES DISABLED')

    def update_pid(self, config: dict) -> None:
        pc = PIDConfig(
            kp=config.get('kp', DEFAULT_PID.kp),
            ki=config.get('ki', DEFAULT_PID.ki),
            kd=config.get('kd', DEFAULT_PID.kd),
            max_angular_velocity=config.get('max_angular_velocity', DEFAULT_PID.max_angular_velocity),
            settling_threshold=config.get('settling_threshold', DEFAULT_PID.settling_threshold),
        )
        self._pid.update_config(pc)
        self._emit_event('info', f'PID UPDATED — Kp={pc.kp} Ki={pc.ki} Kd={pc.kd}')

    def update_kalman(self, config: dict) -> None:
        kc = KalmanConfig(
            process_noise_q=config.get('process_noise_q', DEFAULT_KALMAN.process_noise_q),
            measurement_noise_r=config.get('measurement_noise_r', DEFAULT_KALMAN.measurement_noise_r),
            initial_covariance=config.get('initial_covariance', DEFAULT_KALMAN.initial_covariance),
        )
        self._kalman = KalmanFilter2D(kc)
        self._emit_event('info',
                         f'KALMAN UPDATED — Q={kc.process_noise_q} '
                         f'R={kc.measurement_noise_r} P0={kc.initial_covariance}')

    def update_camera_angles(self, pan: float, tilt: float) -> None:
        """Direct camera control (from CameraControl page)."""
        dt = 1.0 / max(self._camera.config.fps, 1.0)
        self._camera.apply_correction(
            pan - self._camera.pan,
            tilt - self._camera.tilt,
            dt,
        )

    def set_target_offset(self, x: float, y: float, z: float) -> None:
        """Operator-injected target shift (e.g. moving TARGET-01 in 3D).

        The offset becomes part of the true beacon world position, so it
        flows through projection → 2D feed → detection → PID → FOV.
        """
        cx = max(-100.0, min(100.0, x))
        cy = max(-100.0, min(100.0, y))
        cz = max(-100.0, min(100.0, z))
        self._target_offset = Vec3(cx, cy, cz)
        self._emit_event('info', f'TARGET OFFSET → ({cx:.1f}, {cy:.1f}, {cz:.1f}) m')

    # ── Atmospheric optical path ────────────────────────────────
    VALID_ATMOS_MODES = ('clear', 'haze', 'fog', 'rain', 'low_light')

    def _set_atmosphere(self, mode: str, strength: float, emit: bool = True) -> None:
        """Set detection-image atmospheric degradation (haze/fog/rain/low_light).

        Applied inside FrameRenderer BEFORE ImageBeaconDetector sees the
        frame — never as a post-detection effect or frontend-only overlay.
        """
        m = str(mode or 'clear').lower()
        if m not in self.VALID_ATMOS_MODES:
            m = 'clear'
        try:
            s = max(0.0, min(1.0, float(strength)))
        except (TypeError, ValueError):
            s = 0.0
        if m == 'clear':
            s = 0.0
        self._atmos_mode = m
        self._atmos_strength = s
        if emit:
            self._emit_event('info', f'ATMOSPHERE → {m.upper()} strength={s:.2f}')

    def set_atmosphere(self, mode: str, strength: float) -> None:
        self._set_atmosphere(mode, strength, emit=True)

    def _env_baseline_disturbances(self) -> 'DisturbanceConfig':
        """Seed turbulence strength/frequency from the environment preset.

        Maps scintillation_index → turbulence strength and wind_speed →
        turbulence frequency so environment selection genuinely changes
        simulation behaviour. Explicit disturbance config always overrides
        these baselines; a disabled turbulence section has no effect.
        """
        from simulation.environment import get_environment
        try:
            env = get_environment(self._env_type)
        except Exception:
            env = get_environment('urban')
        dc = DisturbanceConfig()
        try:
            si = float(env.scintillation_index)
        except (TypeError, ValueError):
            si = 2e-14
        try:
            ws = float(env.wind_speed)
        except (TypeError, ValueError):
            ws = 6.0
        dc.atmospheric_turbulence.strength = max(0.05, min(1.0, si / 3e-14))
        dc.atmospheric_turbulence.frequency = max(0.5, min(8.0, (ws / 6.0) * 2.0 if ws > 0 else 0.5))
        return dc

    def switch_target(
        self,
        target_id: str = "TARGET-01",
        position: Optional[dict] = None,
        velocity: Optional[dict] = None,
        trajectory: str = "static",
        beacon_offset: Optional[dict] = None,
        satellite_id: Optional[str] = None,
        camera_id: Optional[str] = None,
    ) -> None:
        """Switch coarse-alignment tracking objective to target_id.
        Re-initializes the active tracked target, resets ALL per-target state
        (including missed_frames so we never enter LOST on the first tick),
        and slews the virtual camera toward the new target's angular position.
        """
        init_pos = position if isinstance(position, dict) else {}
        init_vel = velocity if isinstance(velocity, dict) else {}
        bo = beacon_offset if isinstance(beacon_offset, dict) else {}

        traj_map = {
            'static': 'static',
            'straight': 'linear',
            'linear': 'linear',
            'circular': 'circular',
            'sinusoidal': 'sinusoidal',
            'figure_8': 'figure_8',
            'figure8': 'figure_8',
            'fig-8': 'figure_8',
            'spiral': 'spiral',
            'random': 'random_walk',
            'random_walk': 'random_walk',
        }
        resolved_traj = traj_map.get(trajectory.lower(), 'static') \
            if isinstance(trajectory, str) else 'static'

        link = self._target_links.get(target_id, {})
        resolved_camera_id = camera_id or link.get('camera_id', 'FSOC-CAM-01')
        resolved_satellite_id = satellite_id or link.get('satellite_id', 'SAT-01')
        if resolved_camera_id not in self._cameras:
            self.register_camera(resolved_camera_id)
        self._camera = self._cameras[resolved_camera_id]
        for sat in self._satellites.values():
            sat['is_active'] = False
        if resolved_satellite_id not in self._satellites:
            self.register_satellite(resolved_satellite_id, resolved_camera_id)
        self._satellites[resolved_satellite_id]['is_active'] = True

        # Tracking selects a registered target by ID.  It never replaces a
        # different target object (the prior cause of TARGET-01 becoming
        # TARGET-02 in the renderer).  An unregistered ID remains supported
        # for API compatibility, but receives one fresh target instance.
        if target_id not in self._targets:
            self._targets[target_id] = Target(TargetConfig(
                id=target_id,
                initial_position=Vec3(_safe_float(init_pos, 'x', 0.0), _safe_float(init_pos, 'y', 0.0), _safe_float(init_pos, 'z', 350.0)),
                velocity=Vec3(_safe_float(init_vel, 'x', 0.0), _safe_float(init_vel, 'y', 0.0), _safe_float(init_vel, 'z', 0.0)),
                trajectory=resolved_traj,
                intensity=0.95,
                beacon_size_px=10.0,
                beacon_shape='square',
                beacon_offset=Vec3(_safe_float(bo, 'x', 0.0), _safe_float(bo, 'y', 0.0), _safe_float(bo, 'z', 0.0)),
                amplitude_h=80.0,
                amplitude_v=40.0,
                period=20.0,
            ))
        self._target = self._targets[target_id]
        self._target_offset = Vec3(0.0, 0.0, 0.0)
        self._target_links[target_id] = {
            'satellite_id': resolved_satellite_id,
            'camera_id': resolved_camera_id,
            'beacon_id': link.get('beacon_id', f'BEACON-{target_id.split("-")[-1]}'),
        }
        self._tracking_session_id += 1
        self._active_tracking_session = {
            'id': self._tracking_session_id,
            'targetId': target_id,
            'beaconId': self._target_links[target_id]['beacon_id'],
            'satelliteId': resolved_satellite_id,
            'cameraId': resolved_camera_id,
        }

        # ── Critical: reset ALL per-target state ─────────────────────
        # Without this, accumulated missed_frames from the previous target
        # causes _update_target_state() to enter LOST on the very first tick.
        self._missed_frames = 0
        self._lock_count = 0
        self._search_t = 0.0
        self._acq_started = False
        self._target_state = 'SEARCHING'
        self._kalman.reset()
        self._pid.reset()

        # Recalculate lost threshold in case fps changed since loop start
        fps = float(getattr(self._camera.config, 'fps', 60.0))
        self._lost_frames_threshold = max(10, int(fps * self.LOST_GRACE_SECONDS))
        self._coast_frames = max(1, int(fps * 1.0))

        # ── Slew camera toward the new target's angular position ─────
        # This prevents the sweep from starting at the wrong boresight.
        beacon_pos = self._effective_beacon_pos()
        pan_err, tilt_err = self._camera.angular_error_to_target(beacon_pos)
        # Snap directly to pointing at the target so acquisition can begin
        # immediately rather than after a full sweep cycle.  The PID still
        # closes the residual error smoothly on subsequent frames.
        self._camera.apply_correction(pan_err, tilt_err, 1.0)
        # Anchor the sweep on the newly slewed pointing direction.
        self._search_pan0 = self._camera.pan
        self._search_tilt0 = self._camera.tilt

        if hasattr(self._detector, 'set_target'):
            self._detector.set_target(
                self._target_links[target_id]['beacon_id'],
                self._target.config.beacon_size_px,
            )
        self._emit_event('info', f'TRACK TARGET — {target_id}')
        self._emit_event('info', f'ACQUISITION STARTED — SEARCHING FOR {target_id}')

    def move_target(self, target_id: str, position: Optional[dict]) -> dict:
        """Manually relocate one registered target (operator gizmo/panel move).

        Re-anchors that target's trajectory origin and places it there
        immediately. No other target, satellite, camera, or tracking state
        is touched: beacons follow via beacon_offset, and the FSOC camera
        reacts through the normal detection → Kalman → PID pipeline.
        """
        target = self._targets.get(target_id)
        if target is None:
            return {'success': False, 'error': f'Unknown target {target_id}'}
        pos = position if isinstance(position, dict) else {}
        cur = target.position
        x = _safe_float(pos, 'x', cur.x)
        y = _safe_float(pos, 'y', cur.y)
        z = _safe_float(pos, 'z', cur.z)
        target.relocate(x, y, z)
        self._emit_event('info', f'TARGET MOVED — {target_id} → ({x:.1f}, {y:.1f}, {z:.1f})')
        return {'success': True, 'target_id': target_id,
                'position': {'x': x, 'y': y, 'z': z}}

    def reacquire(self) -> None:
        """Force a fresh acquisition attempt from any state (including LOST).
        Resets missed_frames and Kalman without replacing the target.
        """
        self._missed_frames = 0
        self._lock_count = 0
        self._search_t = 0.0
        self._acq_started = False
        self._target_state = 'SEARCHING'
        self._kalman.reset()
        self._pid.reset()
        # Re-slew camera toward current target position
        beacon_pos = self._effective_beacon_pos()
        pan_err, tilt_err = self._camera.angular_error_to_target(beacon_pos)
        self._camera.apply_correction(pan_err, tilt_err, 1.0)
        self._search_pan0 = self._camera.pan
        self._search_tilt0 = self._camera.tilt
        fps = float(getattr(self._camera.config, 'fps', 60.0))
        self._lost_frames_threshold = max(10, int(fps * self.LOST_GRACE_SECONDS))
        self._coast_frames = max(1, int(fps * 1.0))
        self._emit_event('info', f'REACQUIRE — {self._target.config.id}')
        self._emit_event('info', 'SEARCHING FOR BEACON…')

    def _effective_beacon_pos(self) -> Vec3:
        """True beacon world position: target + mount offset + operator offset."""
        t = self._target.position
        b = self._target.config.beacon_offset
        o = self._target_offset
        return Vec3(t.x + b.x + o.x, t.y + b.y + o.y, t.z + b.z + o.z)

    def _slew_toward(self, des_pan: float, des_tilt: float, dt: float) -> None:
        """Move camera toward absolute angles, respecting max slew rate."""
        max_step = self._pid.config.max_angular_velocity * dt
        dpan = max(-max_step, min(max_step, des_pan - self._camera.pan))
        dtilt = max(-max_step, min(max_step, des_tilt - self._camera.tilt))
        self._camera.apply_correction(dpan, dtilt, dt)

    @property
    def status(self) -> str:
        if self._stopped:
            return 'stopped'
        if not self._running:
            return 'idle'
        if self._paused:
            return 'paused'
        return 'running'

    @property
    def run_id(self) -> Optional[str]:
        return self._run_id

    # ── Main loop ─────────────────────────────────────────────

    async def _loop(self) -> None:
        fps = float(self._camera.config.fps or 30.0)
        dt = 1.0 / fps
        # Grace period scales with FPS — at least 3 seconds before declaring LOST
        self._lost_frames_threshold = max(10, int(fps * self.LOST_GRACE_SECONDS))
        self._coast_frames = max(1, int(fps * 1.0))

        while self._running:
            if self._paused:
                await asyncio.sleep(0.05)
                continue

            t0 = time.perf_counter()

            self._frame_id += 1
            self._elapsed += dt
            now = time.time()

            # ── Demo mode phases ───────────────────────────
            if self._demo_mode:
                self._run_demo_phase()

            # ── Platform motion & target update ───────────
            self._camera.update_platform(dt)
            dist_state = self._disturbances.update(dt)
            self._target.update(dt, dist_state['velocity_variation'])

            # Every registered target owns an independent Target instance,
            # clock and transform. Tracking only identifies `self._target`;
            # it never suspends or overwrites the other trajectories.
            for target_id, target in self._targets.items():
                if target is not self._target:
                    target.update(dt, dist_state['velocity_variation'])

            # Build independent telemetry records for all non-tracked targets.
            # They are never aliases of the active target record.
            other_target_dicts = []
            for target_id, target in self._targets.items():
                if target is self._target:
                    continue
                other_pos = Vec3(
                    target.position.x + target.config.beacon_offset.x,
                    target.position.y + target.config.beacon_offset.y,
                    target.position.z + target.config.beacon_offset.z,
                )
                other_proj = self._camera.project_world_to_pixel(other_pos)
                other_dict = target.state_dict(now)
                other_dict['image_position'] = (
                    {'x': round(other_proj[0], 2), 'y': round(other_proj[1], 2)}
                    if other_proj is not None and target.visible else None
                )
                other_dict['is_primary'] = False
                other_link = self._target_links.get(target_id, {})
                other_dict['entity'] = {
                    'id': target_id, 'type': 'target',
                    'beaconId': other_link.get('beacon_id'),
                    'hostSatelliteId': other_link.get('satellite_id'),
                }
                other_dict['beacon'] = {
                    'id': other_link.get('beacon_id'), 'type': 'beacon',
                    'parentTargetId': target_id,
                    'size_px': target.config.beacon_size_px,
                    'shape': target.config.beacon_shape,
                    'intensity': target.config.intensity,
                }
                other_target_dicts.append(other_dict)

            # ── Camera disturbance ─────────────────────────
            if dist_state['dpan'] != 0 or dist_state['dtilt'] != 0:
                self._camera.apply_correction(
                    dist_state['dpan'] * dt,
                    dist_state['dtilt'] * dt,
                    dt
                )

            # ── True beacon world position ───────────────
            # target motion + mount offset + operator offset (3D move)
            beacon_pos = self._effective_beacon_pos()
            proj = self._camera.project_world_to_pixel(beacon_pos)
            target_visible = proj is not None and self._target.visible
            px = proj[0] if proj else None
            py = proj[1] if proj else None

            # Ground-truth telemetry (drives the 3D view + 2D truth image)
            target_dict = self._target.state_dict(now)
            target_dict['image_position'] = (
                {'x': round(px, 2), 'y': round(py, 2)}
                if target_visible else None
            )
            target_dict['is_primary'] = True
            active_link = self._target_links.get(self._target.config.id, {})
            target_dict['entity'] = {
                'id': self._target.config.id,
                'type': 'target',
                'beaconId': active_link.get('beacon_id'),
                'hostSatelliteId': active_link.get('satellite_id'),
            }
            target_dict['beacon'] = {
                'id': active_link.get('beacon_id'),
                'type': 'beacon',
                'parentTargetId': self._target.config.id,
                'size_px': self._target.config.beacon_size_px,
                'shape': self._target.config.beacon_shape,
                'intensity': self._target.config.intensity,
            }

            # ── Render the virtual-camera frame (the observation) ──
            cam_cfg = self._camera.config
            img_w, img_h = cam_cfg.resolution_w, cam_cfg.resolution_h
            turb_cfg = dist_state['config']['atmospheric_turbulence']
            turb_s = turb_cfg['strength'] if turb_cfg['enabled'] else 0.0
            frame_img = self._renderer.render(
                px, py,
                visible=target_visible,
                size_px=self._target.config.beacon_size_px,
                intensity=self._target.config.intensity,
                shape=self._target.config.beacon_shape,
                noise_type=dist_state.get('noise_type', 'gaussian'),
                noise_level=dist_state.get('noise_level', 0.0),
                turb_strength=turb_s,
                atmos_mode=self._atmos_mode,
                atmos_strength=self._atmos_strength,
                rng=self._rng,
            )

            # ── Detection operates ONLY on the rendered image ─────
            detection = self._detector.detect_frame(frame_img)
            det_dict = detection.to_dict() if detection else None

            # ── Centroiding score vs truth (detector characterisation) ──
            if detection and target_visible and px is not None and py is not None:
                px_err_x = round(detection.centroid_x - px, 3)
                px_err_y = round(detection.centroid_y - py, 3)
                px_err_total = round(math.sqrt(px_err_x**2 + px_err_y**2), 3)
            else:
                px_err_x = None
                px_err_y = None
                px_err_total = None

            centroid_err_dict = {
                'pixel_error_x': px_err_x,
                'pixel_error_y': px_err_y,
                'pixel_error_total': px_err_total,
                'centroid_x': round(detection.centroid_x, 2) if detection else None,
                'centroid_y': round(detection.centroid_y, 2) if detection else None,
                'target_px_x': round(px, 2) if target_visible and px is not None else None,
                'target_px_y': round(py, 2) if target_visible and py is not None else None,
            }

            # ── Kalman filter (measurement = detected centroid only) ──
            if detection:
                self._kalman.update(detection.centroid_x, detection.centroid_y)
                self._missed_frames = 0
            else:
                self._missed_frames += 1

            pred_x, pred_y = self._kalman.predict(dt)
            kal_dict = self._kalman.state_dict() if self._kalman.is_initialized else None

            # ── Image-space error → angular error (drives the PID) ──
            cx, cy = img_w / 2.0, img_h / 2.0
            if detection:
                mx, my = detection.centroid_x, detection.centroid_y
                measured_px: Optional[float] = math.sqrt((mx - cx) ** 2 + (my - cy) ** 2)
            elif self._kalman.is_initialized:
                # Coast on the Kalman prediction while the spot is missed
                mx, my = pred_x, pred_y
                measured_px = None
            else:
                mx, my = None, None
                measured_px = None

            if mx is not None:
                pix_err_x = mx - cx
                pix_err_y = my - cy
                pix_total = math.sqrt(pix_err_x ** 2 + pix_err_y ** 2)
                pan_err = pix_err_x * (cam_cfg.fov_h / img_w)
                tilt_err = -pix_err_y * (cam_cfg.fov_v / img_h)
            else:
                pix_err_x, pix_err_y, pix_total = None, None, None
                pan_err, tilt_err = 0.0, 0.0
            total_err = math.sqrt(pan_err**2 + tilt_err**2)

            pixel_err_dict = {
                'x': round(pix_err_x, 2) if pix_err_x is not None else None,
                'y': round(pix_err_y, 2) if pix_err_y is not None else None,
                'total': round(pix_total, 2) if pix_total is not None else None,
            }

            # ── PID control / SEARCHING sweep ──────────────────
            if mx is not None:
                pid_out = self._pid.update(pan_err, tilt_err, dt)
                # Inertial-rate feedforward: current camera rate plus the
                # Kalman-estimated image drift (both in deg/s). This removes
                # velocity lag on moving targets; the PID then only trims
                # the residual. Total single-frame rotation is clamped to
                # the configured maximum angular velocity.
                ff_pan_rate, ff_tilt_rate = 0.0, 0.0
                if self._kalman.is_initialized:
                    kvx, kvy = self._kalman.velocity
                    ff_pan_rate = self._camera.pan_rate + kvx * (cam_cfg.fov_h / img_w)
                    ff_tilt_rate = self._camera.tilt_rate - kvy * (cam_cfg.fov_v / img_h)
                dpan = pid_out['pan_correction'] + ff_pan_rate * dt
                dtilt = pid_out['tilt_correction'] + ff_tilt_rate * dt
                max_step = self._pid.config.max_angular_velocity * dt
                step = math.hypot(dpan, dtilt)
                if step > max_step and step > 0:
                    scale = max_step / step
                    dpan *= scale
                    dtilt *= scale
                self._camera.apply_correction(dpan, dtilt, dt)
                pid_out = {
                    **pid_out,
                    'pan_correction': round(dpan, 5),
                    'tilt_correction': round(dtilt, 5),
                    'ff_pan_rate': round(ff_pan_rate, 4),
                    'ff_tilt_rate': round(ff_tilt_rate, 4),
                }
            else:
                # No measurement and no estimate: expanding search sweep,
                # slew-rate limited like every other camera motion.
                # Centred on the last-known pointing direction: it starts as
                # a dense local scan (highest posterior probability) and
                # expands to the full ±60°/±20° envelope over ~25 s.
                # Zero phase offset so it starts at the centre, not off-axis.
                pid_out = self._pid.coast()
                self._search_t += dt
                ramp = min(1.0, self._search_t / 90.0)
                pan_amp = 8.0 + (self.SEARCH_SWEEP_AMP - 8.0) * ramp
                tilt_amp = 3.0 + (20.0 - 3.0) * ramp
                sweep_pan = (self._search_pan0 + pan_amp * math.sin(
                    self.SEARCH_SWEEP_RATE * self._search_t))
                sweep_tilt = (self._search_tilt0
                              + tilt_amp * math.sin(0.12 * self._search_t))
                self._slew_toward(sweep_pan, sweep_tilt, dt)

            # ── State machine (detection + pixel error) ────────
            self._update_target_state(detection is not None, pix_total)

            # ── Metrics ────────────────────────────────────
            t1 = time.perf_counter()
            processing_ms = (t1 - t0) * 1000.0

            conf = detection.confidence if detection else 0.0
            self._metrics.update(
                frame_time=now,
                processing_ms=processing_ms,
                angular_error=total_err,
                confidence=conf,
                target_state=self._target_state,
                simulation_elapsed=self._elapsed,
                pixel_error=round(pix_total, 3) if measured_px is not None else None,
                measured=detection is not None,
            )

            frame_metrics = self._metrics.frame_metrics()

            # ── Sample DB telemetry (every 5 frames) ───────
            if self._frame_id % 5 == 0 and self._run_id:
                frame_snapshot = {
                    'timestamp': now,
                    'camera': self._camera.state_dict(now),
                    'angular_error': {
                        'pan_error': round(pan_err, 4),
                        'tilt_error': round(tilt_err, 4),
                        'total_error': round(total_err, 4),
                    },
                    'centroiding_error': centroid_err_dict,
                    'metrics': frame_metrics,
                    'kalman': kal_dict,
                    'disturbance': dist_state,
                    'target_state': self._target_state,
                }
                _run_id = self._run_id
                _frame_id = self._frame_id
                asyncio.get_event_loop().run_in_executor(
                    _DB_EXECUTOR,
                    lambda: _safe_save_telemetry(_run_id, frame_snapshot, _frame_id),
                )

            # ── Broadcast telemetry ────────────────────────
            targets_list = [target_dict, *other_target_dicts]

            telemetry = {
                'type': 'telemetry',
                'payload': {
                    'timestamp': now,
                    'frame_id': self._frame_id,
                    'elapsed': round(self._elapsed, 3),
                    'sim_status': self.status,
                    'source': 'virtual',
                    'target_state': self._target_state,
                    'target': target_dict,
                    'tracking_session': self._active_tracking_session,
                    'targets': targets_list,
                    'centroiding_error': centroid_err_dict,
                    'pixel_error': pixel_err_dict,
                    'target_offset': self._target_offset.as_dict(),
                    'camera': self._camera.state_dict(now),
                    'detection': det_dict,
                    'kalman': kal_dict,
                    'angular_error': {
                        'pan_error': round(pan_err, 4),
                        'tilt_error': round(tilt_err, 4),
                        'total_error': round(total_err, 4),
                    },
                    'pid_output': pid_out,
                    'disturbance': dist_state,
                    'atmosphere': {
                        'mode': self._atmos_mode,
                        'strength': round(self._atmos_strength, 3),
                    },
                    'metrics': frame_metrics,
                    'events': self._drain_events(),
                },
            }

            if self._broadcast:
                try:
                    await self._broadcast(telemetry)
                except Exception:
                    pass

            # ── Timing ────────────────────────────────────
            elapsed_loop = time.perf_counter() - t0
            sleep_time = max(0.0, dt - elapsed_loop)
            await asyncio.sleep(sleep_time)

        self._finalize_run('completed')

    # ── State machine (detection + image-space pixel error) ────
    # LOCKED requires the measured error to stay ≤ 10 px for
    # LOCK_FRAMES_REQUIRED consecutive frames — never forced.

    def _update_target_state(self, detected: bool,
                             pix_total: Optional[float]) -> None:
        prev = self._target_state

        if detected and pix_total is not None:
            if pix_total <= self.TARGET_LOCK_THRESHOLD_PX:
                self._lock_count += 1
            else:
                self._lock_count = 0
            if self._lock_count >= self.LOCK_FRAMES_REQUIRED:
                new = 'LOCKED'
            elif pix_total <= self.TARGET_LOCK_THRESHOLD_PX:
                new = 'TRACKING'
            elif pix_total <= self.ACQUIRING_THRESHOLD_PX:
                new = 'ACQUIRING'
            else:
                new = 'DETECTED'
        else:
            self._lock_count = 0
            # Coast-to-sweep handover: after ~1 s without measurements the
            # Kalman prediction is stale. Drop it so the SEARCHING sweep
            # (mx=None path) takes over instead of the PID chasing a
            # diverging prediction forever while Kalman stays initialized
            # (which would also starve the sweep and make LOST unreachable).
            if (self._missed_frames > self._coast_frames
                    and self._kalman.is_initialized):
                self._kalman.reset()
                self._pid.reset()
            if self._missed_frames > self._lost_frames_threshold:
                # LOST fires ONCE per loss episode (from a tracking/search
                # state). While already in LOST/REACQUIRING the sweep keeps
                # running with a monotonically advancing phase — resetting
                # _search_t here would restart the Lissajous every grace
                # period and the camera would never scan past the sweep's
                # initial segment.
                if prev in ('LOST', 'REACQUIRING'):
                    new = 'REACQUIRING'
                    self._missed_frames = 0
                else:
                    new = 'LOST'
                    self._missed_frames = 0
                    self._kalman.reset()  # stale estimate is worthless
                    self._pid.reset()     # avoid windup-driven re-loss
                    # Fresh loss episode: anchor the expanding sweep on the
                    # last-known pointing and restart it as a local scan.
                    self._search_pan0 = self._camera.pan
                    self._search_tilt0 = self._camera.tilt
                    self._search_t = 0.0
                    self._reacquire_start_time = self._elapsed
            elif prev in ('LOST', 'REACQUIRING'):
                # Check for REACQUIRING timeout
                reacquire_duration = self._elapsed - self._reacquire_start_time
                if reacquire_duration > self.REACQUIRE_TIMEOUT_SECONDS:
                    # Timeout: return to SEARCHING; the sweep phase is left
                    # running so coverage continues instead of restarting.
                    new = 'SEARCHING'
                    self._emit_event('warning', f'REACQUIRE TIMEOUT — RETURNING TO SEARCHING ({self.REACQUIRE_TIMEOUT_SECONDS:.0f}s)')
                else:
                    # Active reacquisition: stay in REACQUIRING until detection
                    new = 'REACQUIRING'
            elif prev in ('LOCKED', 'TRACKING', 'ACQUIRING', 'DETECTED'):
                new = 'REACQUIRING'
                self._reacquire_start_time = self._elapsed
            else:
                new = 'SEARCHING'

        if new != prev:
            self._target_state = new
            # Track acquisition windows for event reporting
            if new == 'ACQUIRING' and not self._acq_started:
                self._acq_started = True
                self._emit_event('info', 'ACQUISITION STARTED')
            if new in ('LOST', 'SEARCHING'):
                self._acq_started = False
            state_events = {
                'SEARCHING': ('info', 'SEARCHING FOR BEACON'),
                'DETECTED': ('info', 'BEACON DETECTED'),
                'ACQUIRING': ('info', 'TARGET ACQUIRING'),
                'TRACKING': ('success', 'TRACKING STARTED'),
                'LOCKED': ('success', 'LOCK ACQUIRED — ERROR ≤ 10 PX'),
                'LOST': ('warning', 'TARGET LOST — REACQUIRING…'),
                'REACQUIRING': ('warning', 'REACQUISITION STARTED'),
            }
            if new in state_events:
                lvl, msg = state_events[new]
                self._emit_event(lvl, msg)
            if prev in ('READY', 'SEARCHING', 'DETECTED', 'ACQUIRING') and new == 'TRACKING':
                self._emit_event('success', 'ACQUISITION COMPLETE')
            if prev in ('REACQUIRING', 'LOST') and new in ('TRACKING', 'LOCKED'):
                self._emit_event('success', 'BEACON REACQUIRED — TRACKING RESUMED')

    # ── Demo phases ───────────────────────────────────────────

    def _run_demo_phase(self) -> None:
        """Demo announcements only — the default demo runs CLEAN so the
        closed loop can acquire and hold lock. Disturbances are enabled
        explicitly by the operator via the Disturbances page."""
        phase_schedule = [
            (1.0, self._demo_closed_loop),
        ]
        while self._demo_phase < len(phase_schedule):
            trigger_t, fn = phase_schedule[self._demo_phase]
            if self._elapsed >= trigger_t:
                self._demo_phase += 1
                fn()
            else:
                break

    def _demo_closed_loop(self) -> None:
        self._emit_event('info', 'PID CONTROLLER ENGAGED — CLOSED LOOP ACTIVE')

    # ── Helpers ───────────────────────────────────────────────

    def _apply_config(self, config: dict) -> None:
        env_type = config.get('environment', 'urban')
        try:
            get_environment(env_type)
            self._env_type = env_type
        except Exception:
            self._env_type = 'urban'

        # ── Atmospheric optical path (detection-image degradation) ──
        # Frontend sends atmospheric_mode at start; default is clear (no-op).
        self._set_atmosphere(
            config.get('atmospheric_mode', 'clear'),
            config.get('atmospheric_strength', 0.5),
            emit=False,
        )

        if 'target' in config:
            tc = config['target']
            bo = tc.get('beacon_offset', {'x': 0, 'y': 0, 'z': 0})
            init_pos = tc.get('initial_position', {'x': -8, 'y': 2, 'z': 350})
            if tc.get('random_init'):
                # PS169 default-random initial location (seeded if requested).
                # The beacon stays attached via beacon_offset — only the
                # target anchor is sampled, inside the sweep-reachable range.
                from simulation.target import random_initial_position
                init_pos = random_initial_position(tc.get('seed')).as_dict()
            self._target = Target(TargetConfig(
                id=tc.get('id', 'TARGET-01'),
                initial_position=Vec3(**init_pos),
                velocity=Vec3(**tc.get('velocity', {'x': 6.0, 'y': 0.3, 'z': 0.0})),
                trajectory=tc.get('trajectory', 'linear'),
                intensity=float(tc.get('beacon_intensity', tc.get('intensity', 0.95))),
                beacon_size_px=float(tc.get('beacon_size', tc.get('beacon_size_px', 10.0))),
                beacon_shape=tc.get('beacon_shape', 'square'),
                beacon_offset=Vec3(**bo),
                amplitude_h=tc.get('amplitude_h', 90.0),
                amplitude_v=tc.get('amplitude_v', 45.0),
                period=tc.get('period', 18.0),
            ))
        else:
            self._target = Target(DEFAULT_TARGET)
        # A scenario may supply a named target; keep its explicit relationship
        # in the same registry used by the renderer and tracking controller.
        configured_link = self._target_links.get(self._target.config.id)
        if configured_link is None:
            beacon_id = (config.get('target') or {}).get('beacon_id')
            if not beacon_id:
                raise ValueError(f'[ASTERIA STATE ERROR] target {self._target.config.id} requires beacon_id')
            self._target_links[self._target.config.id] = {
                'satellite_id': (config.get('target') or {}).get('satellite_id', 'SAT-01'),
                'camera_id': (config.get('target') or {}).get('camera_id', 'FSOC-CAM-01'),
                'beacon_id': beacon_id,
            }
        self._targets[self._target.config.id] = self._target
        self._target_offset = Vec3(0.0, 0.0, 0.0)
        self._lock_count = 0
        self._search_t = 0.0
        self._acq_started = False
        # Detector labels/spot-size follow the configured beacon
        if hasattr(self._detector, 'set_target'):
            self._detector.set_target(
                self._target_links.get(self._target.config.id, {}).get('beacon_id', 'BEACON-01'),
                self._target.config.beacon_size_px,
            )

        # Multi-target support
        self._multi_target = bool(config.get('multi_target', False))
        if self._multi_target:
            sec_init = Vec3(
                self._target.config.initial_position.x + 70.0,
                self._target.config.initial_position.y - 35.0,
                self._target.config.initial_position.z + 50.0,
            )
            self._secondary_target = Target(TargetConfig(
                id='TARGET-02',
                initial_position=sec_init,
                velocity=Vec3(1.6, -0.7, 0.0),
                trajectory='figure_8' if self._target.config.trajectory != 'figure_8' else 'circular',
                amplitude_h=self._target.config.amplitude_h * 1.15,
                amplitude_v=self._target.config.amplitude_v * 0.85,
                period=self._target.config.period * 1.25,
            ))
        else:
            self._secondary_target = None

        plat_motion = config.get('platform_motion') or (config.get('camera', {}).get('platform_motion', 'stationary'))
        plat_speed  = float(config.get('platform_speed') or (config.get('camera', {}).get('platform_speed', 2.0)))
        plat_vel = config.get('platform_velocity') or (config.get('camera', {}).get('platform_velocity', {'x': 2.0, 'y': 0.0, 'z': 0.0}))

        if 'camera' in config:
            cc = config['camera']
            self._camera = Camera(CameraConfig(
                fov_h=cc.get('fov_h', 4.0),
                fov_v=cc.get('fov_v', 3.0),
                resolution_w=cc.get('resolution_w', 640),
                resolution_h=cc.get('resolution_h', 480),
                fps=cc.get('fps', 30.0),
                noise_level=cc.get('noise_level', 0.02),
                platform_motion=plat_motion,
                platform_speed=plat_speed,
                platform_velocity=Vec3(**plat_vel),
            ))
        else:
            self._camera = Camera(CameraConfig(
                platform_motion=plat_motion,
                platform_speed=plat_speed,
                platform_velocity=Vec3(**plat_vel),
            ))
        # Renderer resolution always matches the configured camera
        self._renderer = FrameRenderer(
            width=self._camera.config.resolution_w,
            height=self._camera.config.resolution_h,
        )

        # ── Environment baseline → disturbances ───────────────────
        # The environment preset seeds turbulence strength/frequency from its
        # scintillation_index/wind_speed. Explicit disturbance config always
        # wins. Starting from the baseline (not the previous run's engine)
        # also stops disturbance state leaking across runs.
        self._disturbances = DisturbanceEngine(self._env_baseline_disturbances())
        if 'disturbances' in config:
            self._disturbances.update_config(
                self._dict_to_disturbance_config(config['disturbances']))

        if 'pid' in config:
            pc = config['pid']
            self._pid = PIDController(PIDConfig(**{
                k: v for k, v in pc.items()
                if k in ['kp', 'ki', 'kd', 'max_angular_velocity', 'settling_threshold']
            }))
        else:
            self._pid = PIDController(DEFAULT_PID)

        if 'kalman' in config:
            kc = config['kalman']
            self._kalman = KalmanFilter2D(KalmanConfig(**{
                k: v for k, v in kc.items()
                if k in ['process_noise_q', 'measurement_noise_r', 'initial_covariance']
            }))
        else:
            self._kalman = KalmanFilter2D(DEFAULT_KALMAN)

    def _dict_to_disturbance_config(self, d: dict) -> DisturbanceConfig:
        """Merge an incoming (possibly partial) dict into the live config.

        Sections absent from `d` keep their current values, so a partial
        update — e.g. an empty WebSocket payload — can never wipe the other
        disturbances back to defaults. Unknown keys and non-numeric values
        are ignored/dropped by sanitisation instead of raising, because an
        exception here would kill the single simulation task (freeze).
        """
        from simulation.disturbances import (AtmosphericTurbulence,
                                              PlatformVibration, CameraMotion,
                                              SensorNoise, TargetMotionVariation,
                                              sanitize_config)
        import dataclasses
        classes = {
            'atmospheric_turbulence': AtmosphericTurbulence,
            'platform_vibration': PlatformVibration,
            'camera_motion': CameraMotion,
            'sensor_noise': SensorNoise,
            'target_motion_variation': TargetMotionVariation,
        }
        dc = DisturbanceConfig()
        current = self._disturbances.config
        for key, cls in classes.items():
            known = {f.name for f in dataclasses.fields(cls)}
            base = {f: getattr(getattr(current, key), f) for f in known}
            incoming = d.get(key)
            if isinstance(incoming, dict):
                for f in known:
                    if f in incoming:
                        base[f] = incoming[f]
            try:
                setattr(dc, key, cls(**base))
            except TypeError:
                setattr(dc, key, getattr(current, key))
        return sanitize_config(dc)

    def _reset_state(self) -> None:
        self._target.reset()
        if self._secondary_target:
            self._secondary_target.reset()
        self._camera.reset()
        self._disturbances.reset()
        self._kalman.reset()
        self._pid.reset()
        self._metrics.reset()
        self._target_state = 'READY'
        self._target_offset = Vec3(0.0, 0.0, 0.0)
        self._frame_id = 0
        self._elapsed = 0.0
        self._missed_frames = 0
        self._lock_count = 0
        self._search_t = 0.0
        self._search_pan0 = 0.0
        self._search_tilt0 = 0.0
        self._acq_started = False
        self._events = []

    def _finalize_run(self, status: str) -> None:
        if self._run_id:
            summary = self._metrics.summary()
            try:
                db.complete_run(self._run_id, summary, self._target_state, status)
            except Exception:
                pass

    def _emit_event(self, level: str, message: str) -> None:
        self._events.append({
            'id': str(uuid.uuid4()),
            'timestamp': time.time(),
            'level': level,
            'message': message,
        })

    def _drain_events(self) -> list:
        evts = list(self._events)
        self._events = []
        return evts


# ── Singleton engine ──────────────────────────────────────────
engine = SimulationEngine()
