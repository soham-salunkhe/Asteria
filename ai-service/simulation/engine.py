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
    id='BEACON-01',
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

    TARGET_LOCK_THRESHOLD_PX = 10.0  # PS169: Tracking error ≤ 10 pixels
    TARGET_UNLOCK_PX = 15.0
    LOCK_FRAMES_REQUIRED = 15        # stable frames before LOCKED
    SEARCH_SWEEP_AMP = 20.0          # degrees, SEARCHING sweep amplitude
    SEARCH_SWEEP_RATE = 0.25         # rad/s — peak rate stays ≤ 5°/s

    def __init__(self):
        self._running = False
        self._paused = False
        self._task: Optional[asyncio.Task] = None
        self._run_id: Optional[str] = None

        # Components
        self._env_type: EnvironmentType = 'urban'
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

        # State
        self._target_state = 'READY'
        self._frame_id = 0
        self._elapsed = 0.0
        self._missed_frames = 0
        self._lock_count = 0
        self._search_t = 0.0
        self._acq_started = False
        self._events: list[dict] = []
        self._lost_frames_threshold = 30

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
        # A new run must never inherit the paused state of the previous one.
        self._paused = False
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
        self._lost_frames_threshold = max(10, int(fps * 1.0))  # ~1 s of misses → LOST

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

            # Secondary target update if multi-target is enabled
            sec_dict = None
            if self._secondary_target:
                self._secondary_target.update(dt, dist_state['velocity_variation'])
                sec_proj = self._camera.project_world_to_pixel(self._secondary_target.position)
                sec_vis = sec_proj is not None and self._secondary_target.visible
                sec_dict = self._secondary_target.state_dict(now)
                sec_dict['image_position'] = (
                    {'x': round(sec_proj[0], 2), 'y': round(sec_proj[1], 2)}
                    if sec_vis else None
                )
                sec_dict['is_primary'] = False

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
            target_dict['beacon'] = {
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
                # No measurement and no estimate: slow search sweep,
                # slew-rate limited like every other camera motion.
                pid_out = self._pid.coast()
                self._search_t += dt
                sweep_pan = self.SEARCH_SWEEP_AMP * math.sin(
                    self.SEARCH_SWEEP_RATE * self._search_t)
                sweep_tilt = 6.0 * math.sin(0.18 * self._search_t + 1.0)
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
            targets_list = [target_dict]
            if sec_dict:
                targets_list.append(sec_dict)

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
            elif pix_total <= 40.0:
                new = 'ACQUIRING'
            else:
                new = 'DETECTED'
        else:
            self._lock_count = 0
            if self._missed_frames > self._lost_frames_threshold:
                new = 'LOST'
            elif prev in ('LOCKED', 'TRACKING', 'ACQUIRING', 'DETECTED'):
                new = 'REACQUIRING'
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
                'LOST': ('warning', 'TARGET LOST'),
                'REACQUIRING': ('warning', 'REACQUISITION STARTED'),
            }
            if new in state_events:
                lvl, msg = state_events[new]
                self._emit_event(lvl, msg)
            if prev == 'LOST' and new in ('TRACKING', 'LOCKED'):
                self._emit_event('success', 'REACQUISITION COMPLETE')
            if prev in ('READY', 'SEARCHING', 'DETECTED', 'ACQUIRING') and new == 'TRACKING':
                self._emit_event('success', 'ACQUISITION COMPLETE')

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
        self._env_type = config.get('environment', 'urban')

        if 'target' in config:
            tc = config['target']
            bo = tc.get('beacon_offset', {'x': 0, 'y': 0, 'z': 0})
            self._target = Target(TargetConfig(
                id=tc.get('id', 'BEACON-01'),
                initial_position=Vec3(**tc.get('initial_position', {'x': -8, 'y': 2, 'z': 350})),
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
        self._target_offset = Vec3(0.0, 0.0, 0.0)
        self._lock_count = 0
        self._search_t = 0.0
        self._acq_started = False
        # Detector labels/spot-size follow the configured beacon
        if hasattr(self._detector, 'set_target'):
            self._detector.set_target(
                self._target.config.id,
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
                id='BEACON-02',
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
            ))
        else:
            self._camera = Camera(CameraConfig(
                platform_motion=plat_motion,
                platform_speed=plat_speed,
            ))
        # Renderer resolution always matches the configured camera
        self._renderer = FrameRenderer(
            width=self._camera.config.resolution_w,
            height=self._camera.config.resolution_h,
        )

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
