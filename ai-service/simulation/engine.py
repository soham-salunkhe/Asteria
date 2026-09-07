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
from typing import Optional, Callable, Awaitable

from simulation.environment import get_environment, EnvironmentType
from simulation.target import Target, TargetConfig, Vec3
from simulation.camera import Camera, CameraConfig
from simulation.disturbances import DisturbanceEngine, DisturbanceConfig
from prediction.kalman import KalmanFilter2D, KalmanConfig
from control.pid import PIDController, PIDConfig
from vision.detector import create_detector, DetectorInterface
from analytics.metrics import RunMetrics
from database import models as db

# ── Default scenario configuration ───────────────────────────

DEFAULT_PID = PIDConfig(kp=0.8, ki=0.05, kd=0.3,
                        max_angular_velocity=15.0, settling_threshold=0.5)

DEFAULT_KALMAN = KalmanConfig(process_noise_q=0.5,
                               measurement_noise_r=5.0,
                               initial_covariance=500.0)

DEFAULT_TARGET = TargetConfig(
    id='BEACON-01',
    initial_position=Vec3(120.0, 60.0, 350.0),
    velocity=Vec3(2.5, 0.8, 0.0),
    trajectory='sinusoidal',
    amplitude_h=90.0,
    amplitude_v=45.0,
    period=18.0,
)

DEFAULT_CAMERA = CameraConfig(
    position=Vec3(0, 0, 0),
    fov_h=28.0,
    fov_v=21.0,
    resolution_w=640,
    resolution_h=480,
    fps=30.0,
    noise_level=0.02,
)


# ── Target state machine ──────────────────────────────────────

STATES = ['READY', 'SEARCHING', 'DETECTED', 'ACQUIRING',
          'TRACKING', 'LOCKED', 'LOST', 'REACQUIRING', 'ERROR']


class SimulationEngine:
    """
    Self-contained FSOC coarse-PAT simulation engine.
    Creates one asyncio task per run; results are streamed via callback.
    """

    TARGET_LOCK_THRESHOLD = 1.5    # degrees — within this = LOCKED
    ACQUIRING_THRESHOLD = 4.0      # degrees — within this = ACQUIRING
    LOST_FRAMES_THRESHOLD = 20     # consecutive missed frames → LOST

    def __init__(self):
        self._running = False
        self._paused = False
        self._task: Optional[asyncio.Task] = None
        self._run_id: Optional[str] = None

        # Components
        self._env_type: EnvironmentType = 'urban'
        self._target = Target(DEFAULT_TARGET)
        self._camera = Camera(DEFAULT_CAMERA)
        self._disturbances = DisturbanceEngine()
        self._kalman = KalmanFilter2D(DEFAULT_KALMAN)
        self._pid = PIDController(DEFAULT_PID)
        self._detector: DetectorInterface = create_detector(use_yolo=False)
        self._metrics = RunMetrics()

        # State
        self._target_state = 'READY'
        self._frame_id = 0
        self._elapsed = 0.0
        self._missed_frames = 0
        self._events: list[dict] = []

        # Demo-mode phase tracking
        self._demo_mode = False
        self._demo_phase = 0
        self._demo_phase_start = 0.0

        # Broadcast callback — set by WebSocket handler
        self._broadcast: Optional[Callable[[dict], Awaitable[None]]] = None

    # ── Public API ────────────────────────────────────────────

    def set_broadcast(self, fn: Callable[[dict], Awaitable[None]]) -> None:
        self._broadcast = fn

    async def start(self, config: Optional[dict] = None,
                    demo_mode: bool = False) -> str:
        if self._running:
            await self.stop()

        self._apply_config(config or {})
        self._reset_state()
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
        if demo_mode:
            self._target_state = 'SEARCHING'
            self._emit_event('info', 'SEARCHING FOR BEACON…')
        return self._run_id

    async def stop(self) -> None:
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._finalize_run('aborted')
        self._emit_event('warning', 'SIMULATION STOPPED')

    async def pause(self) -> None:
        self._paused = not self._paused
        label = 'SIMULATION PAUSED' if self._paused else 'SIMULATION RESUMED'
        self._emit_event('info', label)

    async def reset(self) -> None:
        await self.stop()
        self._reset_state()

    def update_disturbances(self, config: dict) -> None:
        dc = self._dict_to_disturbance_config(config)
        self._disturbances.update_config(dc)
        self._emit_event('info', f'DISTURBANCES UPDATED — INDEX {self._disturbances.config.atmospheric_turbulence.strength:.2f}')

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

    def update_camera_angles(self, pan: float, tilt: float) -> None:
        """Direct camera control (from CameraControl page)."""
        self._camera.apply_correction(
            pan - self._camera.pan,
            tilt - self._camera.tilt,
            0.033
        )

    @property
    def status(self) -> str:
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
        dt = 1.0 / DEFAULT_CAMERA.fps
        frame_start = time.perf_counter()

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

            # ── Target update ──────────────────────────────
            dist_state = self._disturbances.update(dt)
            self._target.update(dt, dist_state['velocity_variation'])

            # ── Camera disturbance ─────────────────────────
            if dist_state['dpan'] != 0 or dist_state['dtilt'] != 0:
                self._camera.apply_correction(
                    dist_state['dpan'] * dt,
                    dist_state['dtilt'] * dt,
                    dt
                )

            # ── Project target to pixel space ──────────────
            proj = self._camera.project_world_to_pixel(self._target.position)
            target_visible = proj is not None and self._target.visible
            px, py = proj if proj else (0.0, 0.0)

            # Update target's image_position for telemetry
            # Use None when target is outside FOV so the frontend shows '—'
            target_dict = self._target.state_dict(now)
            target_dict['image_position'] = (
                {'x': round(px, 2), 'y': round(py, 2)}
                if target_visible else None
            )

            # ── Detection ─────────────────────────────────
            detection = self._detector.detect(
                pixel_x=px, pixel_y=py,
                image_w=DEFAULT_CAMERA.resolution_w,
                image_h=DEFAULT_CAMERA.resolution_h,
                noise_scale=dist_state['noise_scale'],
                target_visible=target_visible,
            )
            det_dict = detection.to_dict() if detection else None

            # ── Kalman filter ──────────────────────────────
            if detection:
                self._kalman.update(detection.centroid_x, detection.centroid_y)
                self._missed_frames = 0
            else:
                self._missed_frames += 1

            pred_x, pred_y = self._kalman.predict(dt)
            kal_dict = self._kalman.state_dict() if self._kalman.is_initialized else None

            # ── Angular error ─────────────────────────────
            pan_err, tilt_err = self._camera.angular_error_to_target(
                self._target.position)
            total_err = math.sqrt(pan_err**2 + tilt_err**2)

            # ── PID control ────────────────────────────────
            pid_out = self._pid.update(pan_err, tilt_err, dt)
            self._camera.apply_correction(
                pid_out['pan_correction'],
                pid_out['tilt_correction'],
                dt,
            )

            # ── State machine ──────────────────────────────
            self._update_target_state(
                target_visible, detection, total_err, pid_out['settled'])

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
                    'metrics': frame_metrics,
                    'kalman': kal_dict,
                    'disturbance': dist_state,
                    'target_state': self._target_state,
                }
                try:
                    db.save_telemetry_sample(self._run_id, frame_snapshot, self._frame_id)
                except Exception:
                    pass  # non-fatal

            # ── Broadcast telemetry ────────────────────────
            telemetry = {
                'type': 'telemetry',
                'payload': {
                    'timestamp': now,
                    'frame_id': self._frame_id,
                    'elapsed': round(self._elapsed, 3),
                    'sim_status': self.status,
                    'target_state': self._target_state,
                    'target': target_dict,
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

    # ── State machine ─────────────────────────────────────────

    def _update_target_state(self, visible: bool, detection,
                              total_err: float, settled: bool) -> None:
        prev = self._target_state

        if not visible and self._missed_frames > self.LOST_FRAMES_THRESHOLD:
            new = 'LOST'
        elif not visible and self._missed_frames > 5:
            new = 'REACQUIRING' if prev == 'LOCKED' else 'SEARCHING'
        elif detection is None and self._missed_frames > 3:
            new = 'SEARCHING' if prev == 'READY' else 'REACQUIRING' if prev in ('LOCKED', 'TRACKING') else 'SEARCHING'
        elif detection and total_err > self.ACQUIRING_THRESHOLD:
            new = 'DETECTED'
        elif detection and total_err > self.TARGET_LOCK_THRESHOLD:
            new = 'ACQUIRING'
        elif detection and total_err <= self.TARGET_LOCK_THRESHOLD and not settled:
            new = 'TRACKING'
        elif detection and settled and total_err <= self.TARGET_LOCK_THRESHOLD:
            new = 'LOCKED'
        else:
            new = prev

        if new != prev:
            self._target_state = new
            state_events = {
                'DETECTED': ('info', 'BEACON DETECTED'),
                'ACQUIRING': ('info', 'TARGET ACQUIRING'),
                'TRACKING': ('success', 'TRACKING ACTIVE'),
                'LOCKED': ('success', 'TARGET LOCKED — STABLE LOCK ACHIEVED'),
                'LOST': ('warning', 'TARGET LOST — REACQUIRING'),
                'REACQUIRING': ('warning', 'REACQUIRING TARGET'),
                'SEARCHING': ('info', 'SEARCHING FOR BEACON'),
            }
            if new in state_events:
                lvl, msg = state_events[new]
                self._emit_event(lvl, msg)

    # ── Demo phases ───────────────────────────────────────────

    def _run_demo_phase(self) -> None:
        """Advance demo sequence phases based on elapsed time.
        Uses an index counter — avoids O(n) list.index() on every frame.
        """
        phase_schedule = [
            (2.0,  self._demo_spawn_beacon),
            (5.0,  self._demo_enable_pid),
            (15.0, self._demo_introduce_turbulence),
            (22.0, self._demo_introduce_vibration),
            (30.0, self._demo_reset_disturbances),
        ]
        # _demo_phase is a 0-based index of the NEXT phase to fire
        while self._demo_phase < len(phase_schedule):
            trigger_t, fn = phase_schedule[self._demo_phase]
            if self._elapsed >= trigger_t:
                self._demo_phase += 1
                fn()
            else:
                break  # phases are ordered — no need to check further

    def _demo_spawn_beacon(self) -> None:
        self._emit_event('info', 'BEACON SPAWNED — SEARCH INITIATED')

    def _demo_enable_pid(self) -> None:
        self._emit_event('info', 'PID CONTROLLER ENGAGED')

    def _demo_introduce_turbulence(self) -> None:
        cfg = self._disturbances.config
        cfg.atmospheric_turbulence.enabled = True
        cfg.atmospheric_turbulence.strength = 0.4
        self._emit_event('warning', 'ATMOSPHERIC TURBULENCE INTRODUCED — STRENGTH 0.40')

    def _demo_introduce_vibration(self) -> None:
        cfg = self._disturbances.config
        cfg.platform_vibration.enabled = True
        cfg.platform_vibration.amplitude = 1.2
        self._emit_event('warning', 'PLATFORM VIBRATION INTRODUCED — AMP 1.2°')

    def _demo_reset_disturbances(self) -> None:
        cfg = self._disturbances.config
        cfg.atmospheric_turbulence.enabled = False
        cfg.platform_vibration.enabled = False
        self._emit_event('success', 'DISTURBANCES CLEARED — LOCK RESTABILISING')

    # ── Helpers ───────────────────────────────────────────────

    def _apply_config(self, config: dict) -> None:
        self._env_type = config.get('environment', 'urban')

        if 'target' in config:
            tc = config['target']
            self._target = Target(TargetConfig(
                id=tc.get('id', 'BEACON-01'),
                initial_position=Vec3(**tc.get('initial_position', {'x': 120, 'y': 60, 'z': 350})),
                velocity=Vec3(**tc.get('velocity', {'x': 2.5, 'y': 0.8, 'z': 0.0})),
                trajectory=tc.get('trajectory', 'sinusoidal'),
                amplitude_h=tc.get('amplitude_h', 90.0),
                amplitude_v=tc.get('amplitude_v', 45.0),
                period=tc.get('period', 18.0),
            ))
        else:
            self._target = Target(DEFAULT_TARGET)

        if 'camera' in config:
            cc = config['camera']
            self._camera = Camera(CameraConfig(
                fov_h=cc.get('fov_h', 28.0),
                fov_v=cc.get('fov_v', 21.0),
                resolution_w=cc.get('resolution_w', 640),
                resolution_h=cc.get('resolution_h', 480),
                fps=cc.get('fps', 30.0),
                noise_level=cc.get('noise_level', 0.02),
            ))
        else:
            self._camera = Camera(DEFAULT_CAMERA)

        if 'disturbances' in config:
            self._disturbances = DisturbanceEngine(
                self._dict_to_disturbance_config(config['disturbances']))
        else:
            self._disturbances = DisturbanceEngine()

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
        from simulation.disturbances import (AtmosphericTurbulence,
                                              PlatformVibration, CameraMotion,
                                              SensorNoise, TargetMotionVariation)
        dc = DisturbanceConfig()
        if 'atmospheric_turbulence' in d:
            dc.atmospheric_turbulence = AtmosphericTurbulence(**d['atmospheric_turbulence'])
        if 'platform_vibration' in d:
            dc.platform_vibration = PlatformVibration(**d['platform_vibration'])
        if 'camera_motion' in d:
            dc.camera_motion = CameraMotion(**d['camera_motion'])
        if 'sensor_noise' in d:
            dc.sensor_noise = SensorNoise(**d['sensor_noise'])
        if 'target_motion_variation' in d:
            dc.target_motion_variation = TargetMotionVariation(**d['target_motion_variation'])
        return dc

    def _reset_state(self) -> None:
        self._target.reset()
        self._camera.reset()
        self._disturbances.reset()
        self._kalman.reset()
        self._pid.reset()
        self._metrics.reset()
        self._target_state = 'READY'
        self._frame_id = 0
        self._elapsed = 0.0
        self._missed_frames = 0
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
