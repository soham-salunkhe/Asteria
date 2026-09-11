// ============================================================
// FSOC Virtual PAT — Core TypeScript Types
// All interfaces used across the frontend simulation system
// ============================================================

// ── Simulation state ─────────────────────────────────────────

export type SimulationStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'error';

export type TargetState =
  | 'READY'
  | 'SEARCHING'
  | 'DETECTED'
  | 'ACQUIRING'
  | 'TRACKING'
  | 'LOCKED'
  | 'LOST'
  | 'REACQUIRING'
  | 'ERROR';

export type EnvironmentType = 'open_sky' | 'urban' | 'mountain' | 'uav' | 'satellite';

// ── 3-D coordinate ────────────────────────────────────────────

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

// ── Target / Beacon ───────────────────────────────────────────

export interface TargetConfig {
  id: string;
  /** Starting world position in metres */
  initial_position: Vec3;
  /** Velocity vector m/s */
  velocity: Vec3;
  /** Trajectory type */
  trajectory: 'linear' | 'sinusoidal' | 'circular' | 'random_walk';
  /** Beacon luminance 0-1 */
  intensity: number;
}

export interface TargetState3D {
  id: string;
  position: Vec3;
  velocity: Vec3;
  /** Pixel coordinates in camera frame — null when target is outside FOV */
  image_position: Vec2 | null;
  timestamp: number;
  is_primary?: boolean;
  /** Beacon spot geometry driving the synthetic camera image */
  beacon?: {
    size_px: number;
    shape: string;
    intensity: number;
  };
}

// ── Camera ────────────────────────────────────────────────────

export interface CameraConfig {
  /** World position */
  position: Vec3;
  /** Horizontal field of view, degrees */
  fov_h: number;
  /** Vertical field of view, degrees */
  fov_v: number;
  /** Image resolution */
  resolution: { width: number; height: number };
  /** Frames per second */
  fps: number;
  /** Image noise standard deviation 0-1 */
  noise_level: number;
}

export interface CameraState {
  /** Pan angle, degrees, −180 to +180 */
  pan: number;
  /** Tilt angle, degrees, −90 to +90 */
  tilt: number;
  /** Angular rates deg/s */
  pan_rate: number;
  tilt_rate: number;
  fov_h: number;
  fov_v: number;
  platform_motion?: string;
  position?: Vec3;
  timestamp: number;
}

// ── Detection ─────────────────────────────────────────────────

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CentroidingError {
  pixel_error_x: number | null;
  pixel_error_y: number | null;
  pixel_error_total: number | null;
  centroid_x: number | null;
  centroid_y: number | null;
  target_px_x: number | null;
  target_px_y: number | null;
}

export interface DetectionResult {
  detected: boolean;
  target_id?: string;
  /** YOLO class label */
  class: string;
  confidence: number;
  bounding_box: BoundingBox;
  /** Pixel centroid */
  centroid: Vec2;
  timestamp: number;
  /** Processing time ms */
  inference_ms: number;
  /** Which detector was used */
  detector: 'yolo' | 'mock' | 'image';
}

// ── Kalman filter ─────────────────────────────────────────────

export interface KalmanState {
  /** Estimated pixel position */
  position: Vec2;
  /** Estimated pixel velocity */
  velocity: Vec2;
  /** Predicted NEXT position */
  predicted_position: Vec2;
  /** Covariance trace — lower = more confident */
  uncertainty: number;
  /** Whether Kalman has converged */
  converged: boolean;
}

// ── Angular error ─────────────────────────────────────────────

export interface AngularError {
  pan_error: number;
  tilt_error: number;
  /** Euclidean magnitude, degrees */
  total_error: number;
}

export interface PixelError {
  x: number | null;
  y: number | null;
  /** Euclidean magnitude, pixels */
  total: number | null;
}

export interface PS169Item {
  value: number | null;
  pass: boolean;
}

// ── PID controller ────────────────────────────────────────────

export interface PIDConfig {
  kp: number;
  ki: number;
  kd: number;
  /** deg/s */
  max_angular_velocity: number;
  /** degrees — within this range = settled */
  settling_threshold: number;
}

export interface PIDOutput {
  pan_correction: number;
  tilt_correction: number;
  pan_integral: number;
  tilt_integral: number;
  pan_derivative: number;
  tilt_derivative: number;
  settled: boolean;
  /** Kalman velocity feedforward rates, deg/s */
  ff_pan_rate?: number;
  ff_tilt_rate?: number;
}

// ── Disturbances ──────────────────────────────────────────────

export interface AtmosphericTurbulence {
  enabled: boolean;
  /** 0-1 */
  strength: number;
  /** Hz */
  frequency: number;
}

export interface PlatformVibration {
  enabled: boolean;
  /** degrees peak-to-peak */
  amplitude: number;
  /** Hz */
  frequency: number;
}

export interface CameraMotion {
  enabled: boolean;
  /** degrees standard deviation per frame */
  angular_disturbance: number;
}

export interface SensorNoise {
  enabled: boolean;
  /** 0-1 */
  noise_level: number;
  /** 'gaussian' | 'salt_pepper' | 'poisson' */
  noise_type?: string;
}

export interface TargetMotionVariation {
  enabled: boolean;
  /** fraction of base velocity */
  velocity_variation: number;
}

export interface DisturbanceConfig {
  atmospheric_turbulence: AtmosphericTurbulence;
  platform_vibration: PlatformVibration;
  camera_motion: CameraMotion;
  sensor_noise: SensorNoise;
  target_motion_variation: TargetMotionVariation;
}

export interface DisturbanceState {
  /** 0-1 combined index */
  total_disturbance_index: number;
  active_count: number;
  /** Instantaneous perturbations applied this frame */
  current_perturbation: Vec2;
  config: DisturbanceConfig;
}

// ── Telemetry frame (streamed via WebSocket) ──────────────────

export interface TelemetryFrame {
  /** Server-side Unix ms */
  timestamp: number;
  /** Sequential frame number */
  frame_id: number;
  /** Simulation wall-time elapsed seconds */
  elapsed: number;

  sim_status: SimulationStatus;
  target_state: TargetState;

  target: TargetState3D;
  /** Multiple targets when multi-target mode is active */
  targets?: TargetState3D[];
  /** Centroiding pixel errors */
  centroiding_error?: CentroidingError;
  camera: CameraState;

  detection: DetectionResult | null;
  kalman: KalmanState | null;

  angular_error: AngularError;
  /** Image-space error vs frame centre, pixels (drives the PID) */
  pixel_error?: PixelError | null;
  /** Operator-injected target shift, metres (3D move → loop) */
  target_offset?: Vec3;
  /** 'virtual' | 'video_input' */
  source?: string;
  video_progress?: number;
  pid_output: PIDOutput;

  disturbance: DisturbanceState;

  metrics: FrameMetrics;

  events: EventLogEntry[];
}

// ── Per-frame metrics ─────────────────────────────────────────

export interface FrameMetrics {
  fps: number;
  processing_ms: number;
  detection_confidence: number;
  lock_fraction: number;
  /** Smoothed acquisition time seconds — null until acquired */
  acquisition_time: number | null;
  average_error: number;
  max_error: number;
  lock_retention: number;
  /** Tracking-phase image-space error, pixels — null before tracking */
  average_error_px: number | null;
  max_error_px: number | null;
  /** O(1) RMSE over TRACKING/LOCKED frames — null until ≥2 samples */
  rmse_px?: number | null;
  /** Frames with no valid measurement, % */
  target_loss_pct: number;
  avg_reacquisition_time: number | null;
  /** PS169 benchmark evaluation (all values measured live) */
  ps169?: Record<string, PS169Item>;
}

// ── Event log ─────────────────────────────────────────────────

export interface EventLogEntry {
  id: string;
  timestamp: number;
  level: 'info' | 'warning' | 'error' | 'success';
  message: string;
}

// ── Scenario ──────────────────────────────────────────────────

export interface ScenarioConfig {
  id: string;
  name: string;
  description: string;
  environment: EnvironmentType;
  target: TargetConfig;
  camera: CameraConfig;
  disturbances: DisturbanceConfig;
  pid: PIDConfig;
  kalman: KalmanConfig;
}

export interface KalmanConfig {
  /** Process noise covariance */
  process_noise_q: number;
  /** Measurement noise covariance */
  measurement_noise_r: number;
  /** Initial state uncertainty */
  initial_covariance: number;
}

// ── Simulation run record ─────────────────────────────────────

export interface SimulationRun {
  run_id: string;
  scenario_id: string;
  scenario_name: string;
  environment: EnvironmentType;
  started_at: string;
  duration: number;
  acquisition_time: number | null;
  average_error: number;
  max_error: number;
  lock_retention: number;
  avg_fps: number;
  processing_ms: number;
  detection_confidence: number;
  final_state: TargetState;
  status: 'completed' | 'failed' | 'aborted';
}

// ── Reports ───────────────────────────────────────────────────

export type ReportFormat = 'csv' | 'json' | 'pdf';

export interface ReportRequest {
  run_id: string;
  format: ReportFormat;
}

// ── Detection pipeline stage ──────────────────────────────────

export interface PipelineStage {
  name: string;
  status: 'idle' | 'active' | 'done' | 'error';
  latency_ms: number;
}

// ── WebSocket message types ───────────────────────────────────

export type WsMessageType =
  | 'telemetry'
  | 'event'
  | 'status'
  | 'error'
  | 'ping';

export interface WsMessage {
  type: WsMessageType;
  payload: unknown;
}

// ── UI store slices ───────────────────────────────────────────

export interface SimulationStore {
  status: SimulationStatus;
  runId: string | null;
  latestFrame: TelemetryFrame | null;
  history: TelemetryFrame[];
  events: EventLogEntry[];
  disturbances: DisturbanceConfig;
  pidConfig: PIDConfig;
  kalmanConfig: KalmanConfig;
  scenarios: ScenarioConfig[];
  activeScenario: ScenarioConfig | null;
}
