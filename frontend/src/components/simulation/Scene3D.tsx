/**
 * FSOC — Engineering 3-D Scene (upgraded visualisation layer)
 *
 * Presentation-only upgrade. The telemetry contract is untouched:
 *   - `frame` / `history` props are the same as before.
 *   - The virtual FSOC camera orientation is driven ONLY by
 *     frame.camera.pan / tilt / fov (the live tracking loop).
 *   - The operator's view (OrbitControls) is fully decoupled from the
 *     virtual tracking camera — orbiting never changes pan/tilt.
 *
 * Tracking loop preserved:
 *   Target motion → virtual camera → 2D feed → detection → Kalman →
 *   pan/tilt controller → virtual camera orientation → updated 3D FOV.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, Line, OrbitControls, TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import { fsocApi } from '../../services/fsocApi';
import type { TelemetryFrame } from '../../types/fsoc';

// ── World constants (unchanged mapping) ──────────────────────────
const WORLD_SCALE = 0.008;
const SAT_A_POSITION: [number, number, number] = [0.15, 0.1, 0.15];
const EARTH_POSITION: [number, number, number] = [-2.55, -0.7, -2.15];
const EARTH_RADIUS = 1.55;
const SCENE_BG = '#101a29'; // deep-space navy — dark, but objects stay distinguishable
const DEFAULT_TARGET: [number, number, number] = [0.15 + 120 * WORLD_SCALE, 0.1 + 60 * WORLD_SCALE, 0.15 + 350 * WORLD_SCALE];

type V3 = [number, number, number];
type MotionMode = 'static' | 'straight' | 'circular' | 'figure8' | 'random' | 'spiral' | 'sinusoidal';
type LocalKind = 'target' | 'satellite';

interface SceneObjectDef {
  id: string;
  kind: LocalKind;
  label: string;
  displayLabel: string;
  hostId: string;
  beaconId: string;
  trackingState: 'IDLE' | 'TRACKING' | 'LOCKED' | 'LOST';
  base: V3; // spawn anchor — motion is applied as an offset on top
  rotation: V3;
  motion: MotionMode;
  ampH: number;
  ampV: number;
  period: number;
  vel: V3;
  spawnedAt: number; // wall-clock seconds, for motion phase
}

interface SceneSettings {
  brightness: number;
  stars: boolean;
  fov: boolean;
  trajectory: boolean;
  labels: boolean;
}

const MOTION_MODES: MotionMode[] = ['static', 'straight', 'circular', 'figure8', 'random', 'spiral', 'sinusoidal'];

// ── Client-side motion model (visualisation-only extras) ─────────
function pingPong(t: number, period: number): number {
  const span = Math.max(period, 0.001);
  const ph = (t % (2 * span)) / span;
  return ph < 1 ? ph : 2 - ph;
}

function motionOffset(o: SceneObjectDef, t: number): V3 {
  const w = (2 * Math.PI) / Math.max(o.period, 0.001);
  const s = t - o.spawnedAt;
  switch (o.motion) {
    case 'straight': {
      const k = pingPong(s, o.period) * o.period; // back-and-forth so it stays in view
      return [o.vel[0] * k, o.vel[1] * k, o.vel[2] * k];
    }
    case 'circular':
      return [o.ampH * Math.cos(w * s), o.ampV * 0.25 * Math.sin(2 * w * s), o.ampH * Math.sin(w * s)];
    case 'figure8':
      return [o.ampH * Math.sin(w * s), o.ampV * 0.3 * Math.sin(2 * w * s + Math.PI / 2), o.ampH * 0.6 * Math.sin(2 * w * s)];
    case 'sinusoidal':
      return [o.ampH * Math.sin(w * s), o.ampV * Math.sin(2 * w * s + 0.5), 0];
    case 'spiral': {
      const ph = (s % Math.max(o.period, 0.001)) / Math.max(o.period, 0.001);
      const r = o.ampH * (0.2 + 0.8 * ph);
      const a = ph * Math.PI * 4;
      return [r * Math.cos(a), o.ampV * (ph - 0.5) * 2, r * Math.sin(a)];
    }
    case 'random':
      return [
        o.ampH * 0.5 * (Math.sin(0.31 * s) + Math.sin(0.173 * s + 1.3)),
        o.ampV * 0.5 * (Math.sin(0.267 * s + 0.7) + Math.sin(0.411 * s + 2.1)),
        o.ampH * 0.35 * (Math.sin(0.211 * s + 2.6) + Math.sin(0.359 * s + 0.4)),
      ];
    default:
      return [0, 0, 0];
  }
}

function motionVelocity(o: SceneObjectDef, t: number): V3 {
  const e = 0.05;
  const a = motionOffset(o, t + e);
  const b = motionOffset(o, t - e);
  return [(a[0] - b[0]) / (2 * e), (a[1] - b[1]) / (2 * e), (a[2] - b[2]) / (2 * e)];
}

// ── Procedural textures ──────────────────────────────────────────
function makeEarthTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const ocean = ctx.createLinearGradient(0, 0, 0, canvas.height);
  ocean.addColorStop(0, '#12384e');
  ocean.addColorStop(0.45, '#16556f');
  ocean.addColorStop(1, '#0a2a40');
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const land = '#6d8a72';
  const landDark = '#4c6a58';
  const blobs = [
    [[110, 180], [190, 135], [275, 175], [330, 260], [285, 335], [205, 315], [160, 390], [92, 320]],
    [[355, 120], [430, 85], [500, 142], [470, 218], [405, 255], [350, 205]],
    [[610, 160], [720, 125], [790, 205], [742, 275], [650, 260], [594, 214]],
    [[820, 310], [930, 275], [1035, 330], [1010, 430], [920, 485], [842, 428]],
    [[1120, 150], [1230, 120], [1335, 182], [1300, 255], [1185, 280], [1105, 235]],
    [[1360, 330], [1480, 295], [1588, 345], [1610, 450], [1510, 500], [1410, 452]],
    [[1650, 170], [1775, 140], [1875, 215], [1820, 300], [1710, 275]],
    [[420, 670], [500, 610], [565, 678], [535, 785], [470, 850], [405, 770]],
    [[760, 690], [850, 640], [925, 710], [895, 820], [820, 885], [752, 815]],
    [[1335, 690], [1415, 640], [1480, 700], [1440, 800], [1372, 845], [1300, 770]],
  ];
  blobs.forEach((points, index) => {
    ctx.beginPath();
    points.forEach(([x, y], pointIndex) => {
      if (pointIndex === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = index % 3 === 0 ? landDark : land;
    ctx.globalAlpha = 0.85;
    ctx.fill();
  });

  ctx.globalAlpha = 0.28;
  ctx.fillStyle = '#dfe9e2';
  ctx.fillRect(0, 0, canvas.width, 42);
  ctx.fillRect(0, canvas.height - 38, canvas.width, 38);
  ctx.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function makeCloudTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < 90; i += 1) {
    const x = (i * 197.3) % canvas.width;
    const y = 90 + ((i * 83.7) % 330);
    const width = 40 + ((i * 31) % 130);
    const height = 4 + ((i * 17) % 18);
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, width);
    gradient.addColorStop(0, 'rgba(240,248,244,0.34)');
    gradient.addColorStop(1, 'rgba(240,248,244,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.ellipse(x, y, width, height, ((i % 9) - 4) * 0.08, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function makeGlowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// ── Lighting rig (controlled, aerospace — never game-bright) ─────
function SceneLights({ brightness }: { brightness: number }) {
  const b = brightness;
  return (
    <group>
      <ambientLight intensity={0.55 * b} color="#9db8c4" />
      <hemisphereLight args={['#3a4f68', '#090c11', 0.5 * b]} />
      {/* key / sun */}
      <directionalLight position={[-5, 3, 4]} intensity={1.9 * b} color="#fff1d6" />
      {/* cool rim from behind-below so dark bodies separate from the bg */}
      <directionalLight position={[4, -1.5, -4]} intensity={0.75 * b} color="#6fa8c8" />
      {/* gentle top fill */}
      <directionalLight position={[1, 5, 1]} intensity={0.35 * b} color="#c8d8de" />
    </group>
  );
}

function StarField({ visible }: { visible: boolean }) {
  const points = useMemo(() => {
    const values: number[] = [];
    const N = 320;
    for (let i = 0; i < N; i += 1) {
      const phi = Math.acos(1 - 2 * ((i + 0.5) / N));
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const radius = 24 + (i % 7) * 1.6;
      values.push(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.sin(theta),
      );
    }
    return new Float32Array(values);
  }, []);
  if (!visible) return null;
  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[points, 3]} />
      </bufferGeometry>
      <pointsMaterial color="#d4e2e4" size={0.04} sizeAttenuation transparent opacity={0.55} depthWrite={false} />
    </points>
  );
}

function Earth({ brightness }: { brightness: number }) {
  const surface = useMemo(() => makeEarthTexture(), []);
  const clouds = useMemo(() => makeCloudTexture(), []);
  const cloudRef = useRef<THREE.Mesh>(null!);

  useFrame((_, dt) => {
    if (cloudRef.current) cloudRef.current.rotation.y += dt * 0.018;
  });

  return (
    <group position={EARTH_POSITION}>
      {/* surface — lifted just enough to read continents against space */}
      <mesh>
        <sphereGeometry args={[EARTH_RADIUS, 64, 48]} />
        <meshStandardMaterial
          map={surface ?? undefined}
          color="#93a8a3"
          roughness={0.72}
          metalness={0.04}
        />
      </mesh>
      <mesh ref={cloudRef} scale={1.012}>
        <sphereGeometry args={[EARTH_RADIUS, 64, 48]} />
        <meshStandardMaterial
          map={clouds ?? undefined}
          transparent
          opacity={0.4}
          depthWrite={false}
          roughness={1}
        />
      </mesh>
      {/* restrained atmospheric rim */}
      <mesh scale={1.045}>
        <sphereGeometry args={[EARTH_RADIUS, 48, 32]} />
        <meshBasicMaterial
          color="#6fb4c6"
          transparent
          opacity={0.16 * brightness}
          side={THREE.BackSide}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      <mesh scale={1.13}>
        <sphereGeometry args={[EARTH_RADIUS, 48, 32]} />
        <meshBasicMaterial
          color="#3f7d95"
          transparent
          opacity={0.06 * brightness}
          side={THREE.BackSide}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      {/* ground-station marker */}
      <mesh position={[0, 0, EARTH_RADIUS * 0.99]}>
        <sphereGeometry args={[0.018, 12, 8]} />
        <meshBasicMaterial color="#e8f4ee" transparent opacity={0.9} />
      </mesh>
    </group>
  );
}

// ── Small unobtrusive 3-D label ──────────────────────────────────
function ObjLabel({ text, color = '#cfe0da', offset = 0.42 }: { text: string; color?: string; offset?: number }) {
  return (
    <Html center distanceFactor={11} position={[0, offset, 0]} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
      <div
        style={{
          fontFamily: 'monospace',
          fontSize: 9,
          letterSpacing: '0.08em',
          color,
          background: 'rgba(6,12,16,0.72)',
          border: '1px solid rgba(160,190,185,0.28)',
          padding: '1px 5px',
          whiteSpace: 'nowrap',
          userSelect: 'none',
        }}
      >
        {text}
      </div>
    </Html>
  );
}

// ── Satellite bus (brighter materials + rim strip for contrast) ──
function SatelliteMesh({ target = false, accent }: { target?: boolean; accent?: string }) {
  const strobeRef = useRef<THREE.Mesh>(null!);
  useFrame(({ clock }) => {
    if (strobeRef.current) {
      const m = strobeRef.current.material as THREE.MeshBasicMaterial;
      m.opacity = 0.35 + 0.55 * Math.max(0, Math.sin(clock.elapsedTime * 2.4));
    }
  });
  return (
    <group>
      {/* main bus — lifted mid-greys so it separates from the navy bg */}
      <mesh>
        <boxGeometry args={[0.34, 0.22, 0.26]} />
        <meshStandardMaterial color={target ? '#5c686b' : '#454f52'} metalness={0.72} roughness={0.34} />
      </mesh>
      {/* pale equipment panel (catches the key light) */}
      <mesh position={[0, 0.02, 0.145]}>
        <boxGeometry args={[0.2, 0.13, 0.012]} />
        <meshStandardMaterial color="#a8a894" metalness={0.4} roughness={0.42} />
      </mesh>
      {/* rim/highlight strip along the top edge */}
      <mesh position={[0, 0.115, 0]}>
        <boxGeometry args={[0.34, 0.012, 0.26]} />
        <meshBasicMaterial color={target ? '#c9b088' : '#8fd0c4'} transparent opacity={0.5} />
      </mesh>
      <SolarPanel side={-1} />
      <SolarPanel side={1} />
      <mesh position={[0, -0.15, 0]}>
        <boxGeometry args={[0.25, 0.025, 0.17]} />
        <meshStandardMaterial color="#9a7d55" metalness={0.55} roughness={0.44} />
      </mesh>
      <mesh position={[0.19, 0.01, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.025, 0.025, 0.18, 10]} />
        <meshStandardMaterial color="#c6c6b6" metalness={0.9} roughness={0.24} />
      </mesh>
      <Antenna position={[0.04, 0.15, 0.04]} />
      <Antenna position={[-0.09, -0.02, -0.16]} rotation={[Math.PI / 2, 0, 0]} />
      {/* mast + strobe so the object reads at a glance */}
      <Line points={[[0, 0, 0], [0, 0.36, 0]]} color="#9db8b2" lineWidth={0.5} transparent opacity={0.5} />
      <mesh ref={strobeRef} position={[0, 0.38, 0]}>
        <sphereGeometry args={[0.014, 8, 8]} />
        <meshBasicMaterial color="#eaf6f0" transparent opacity={0.7} />
      </mesh>
      {/* nameplate */}
      <mesh position={[0, 0, 0.145]}>
        <boxGeometry args={[0.09, 0.045, 0.008]} />
        <meshBasicMaterial color={accent ?? (target ? '#d1ac6b' : '#73c8bd')} transparent opacity={0.85} />
      </mesh>
    </group>
  );
}

function SolarPanel({ side }: { side: -1 | 1 }) {
  return (
    <group position={[side * 0.58, 0, 0]}>
      <mesh>
        <boxGeometry args={[0.82, 0.025, 0.34]} />
        <meshStandardMaterial color="#1d4258" emissive="#0a1c2a" emissiveIntensity={0.8} metalness={0.55} roughness={0.32} />
      </mesh>
      <mesh position={[0, 0.016, 0]}>
        <boxGeometry args={[0.78, 0.008, 0.3]} />
        <meshStandardMaterial color="#3b7d99" emissive="#0e2c3c" emissiveIntensity={0.55} metalness={0.35} roughness={0.3} />
      </mesh>
      {[-0.22, 0, 0.22].map((z) => (
        <mesh key={z} position={[0, 0.022, z]}>
          <boxGeometry args={[0.78, 0.006, 0.008]} />
          <meshBasicMaterial color="#8fc3d4" transparent opacity={0.6} />
        </mesh>
      ))}
      <mesh position={[0, -0.04, 0]}>
        <boxGeometry args={[0.8, 0.018, 0.025]} />
        <meshStandardMaterial color="#b3a36f" metalness={0.8} roughness={0.35} />
      </mesh>
    </group>
  );
}

function Antenna({ position, rotation = [0, 0, 0] as [number, number, number] }: { position: [number, number, number]; rotation?: [number, number, number] }) {
  return (
    <group position={position} rotation={rotation}>
      <mesh rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.018, 0.018, 0.22, 10]} />
        <meshStandardMaterial color="#b9bdb4" metalness={0.8} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0, -0.08]}>
        <sphereGeometry args={[0.035, 12, 8]} />
        <meshStandardMaterial color="#d0c08a" metalness={0.7} roughness={0.3} />
      </mesh>
    </group>
  );
}

function GimbalTerminal({ pan, tilt, active }: { pan: number; tilt: number; active: boolean }) {
  const tiltRef = useRef<THREE.Group>(null!);
  const panRef = useRef<THREE.Group>(null!);
  const targetPan = THREE.MathUtils.degToRad(pan);
  const targetTilt = THREE.MathUtils.degToRad(tilt);

  useFrame((_, dt) => {
    if (!panRef.current || !tiltRef.current) return;
    panRef.current.rotation.y = THREE.MathUtils.damp(panRef.current.rotation.y, targetPan, 7, dt);
    tiltRef.current.rotation.x = THREE.MathUtils.damp(tiltRef.current.rotation.x, targetTilt, 7, dt);
  });

  return (
    <group position={[0, 0.15, -0.02]}>
      <mesh>
        <cylinderGeometry args={[0.11, 0.13, 0.06, 20]} />
        <meshStandardMaterial color="#6b7674" metalness={0.82} roughness={0.28} />
      </mesh>
      <mesh position={[0, 0.08, 0]}>
        <boxGeometry args={[0.22, 0.08, 0.16]} />
        <meshStandardMaterial color="#3d4748" metalness={0.75} roughness={0.34} />
      </mesh>
      <group ref={panRef}>
        <mesh position={[0.12, 0.08, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.035, 0.035, 0.13, 14]} />
          <meshStandardMaterial color="#c2ab76" metalness={0.78} roughness={0.28} />
        </mesh>
        <group ref={tiltRef}>
          <mesh position={[0, 0.08, 0]} rotation={[0, Math.PI / 2, 0]}>
            <cylinderGeometry args={[0.075, 0.09, 0.28, 24]} />
            <meshStandardMaterial color="#556364" metalness={0.88} roughness={0.25} />
          </mesh>
          <mesh position={[0, 0.08, -0.16]} rotation={[0, Math.PI / 2, 0]}>
            <cylinderGeometry args={[0.042, 0.056, 0.025, 24]} />
            <meshStandardMaterial color={active ? '#8ed6c2' : '#4d7778'} emissive={active ? '#1b6f69' : '#0a2326'} emissiveIntensity={active ? 1.7 : 0.6} metalness={0.3} roughness={0.18} />
          </mesh>
          <mesh position={[0, 0.08, 0.045]} rotation={[0, Math.PI / 2, 0]}>
            <torusGeometry args={[0.084, 0.012, 8, 28]} />
            <meshStandardMaterial color="#bfa86f" metalness={0.75} roughness={0.31} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

// ── Optical beacon: bright core + restrained halo ─────────────────
function Beacon({ color = '#bfe6ff', scale = 1 }: { color?: string; scale?: number }) {
  const glow = useMemo(() => makeGlowTexture(), []);
  const spriteRef = useRef<THREE.Sprite>(null!);
  const coreRef = useRef<THREE.Mesh>(null!);
  useFrame(({ clock }) => {
    const p = 1 + 0.12 * Math.sin(clock.elapsedTime * 3.2);
    if (spriteRef.current) spriteRef.current.scale.set(0.55 * scale * p, 0.55 * scale * p, 1);
    if (coreRef.current) coreRef.current.scale.setScalar(p);
  });
  return (
    <group>
      <mesh ref={coreRef}>
        <sphereGeometry args={[0.045 * scale, 16, 12]} />
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.075 * scale, 16, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.85} toneMapped={false} />
      </mesh>
      <sprite ref={spriteRef}>
        <spriteMaterial map={glow} color={color} transparent opacity={0.5} blending={THREE.AdditiveBlending} depthWrite={false} />
      </sprite>
      <pointLight color={color} intensity={1.2} distance={3.2} decay={2} />
    </group>
  );
}

// ── Virtual FSOC camera rig — orientation ONLY from telemetry ────
// beaconWorldPos: world-space position of the CURRENTLY TRACKED beacon.
//   - For the live backend target this is targetPosition + local beacon offset.
//   - For a user-added target this is reported each frame by LocalObject.reportPosition(beaconId).
// SAT-01 does NOT move — only the rig's pan/tilt rotation changes.
function VirtualFsocRig({
  frame,
  liveId,
  targetPosition,
  beaconWorldPos,
  showFov,
  showLabels,
  reportPosition,
}: {
  frame: TelemetryFrame | null;
  liveId: string;
  targetPosition: V3;
  beaconWorldPos: V3;   // world position of the ACTIVE beacon (drives FOV line-of-sight)
  showFov: boolean;
  showLabels: boolean;
  reportPosition: (id: string, p: V3) => void;
}) {
  const pan = frame?.camera.pan ?? 0;
  const tilt = frame?.camera.tilt ?? 0;
  const fovH = frame?.camera.fov_h ?? 4;
  const fovV = frame?.camera.fov_v ?? 3;
  const state = frame?.target_state ?? 'READY';
  const linkActive = state === 'ACQUIRING' || state === 'TRACKING' || state === 'LOCKED' || state === 'REACQUIRING';

  const rigRef = useRef<THREE.Group>(null!);
  const targetPan = THREE.MathUtils.degToRad(pan);
  const targetTilt = THREE.MathUtils.degToRad(tilt);

  useFrame((_, dt) => {
    if (!rigRef.current) return;
    rigRef.current.rotation.y = THREE.MathUtils.damp(rigRef.current.rotation.y, targetPan, 7, dt);
    rigRef.current.rotation.x = THREE.MathUtils.damp(rigRef.current.rotation.x, targetTilt, 7, dt);
  });

  useEffect(() => {
    // Report the live target position so NavRig FOLLOW/FOCUS can track it.
    reportPosition(liveId, targetPosition);
  }, [targetPosition, reportPosition, liveId]);

  const halfH = THREE.MathUtils.degToRad(fovH / 2);
  const halfV = THREE.MathUtils.degToRad(fovV / 2);
  // PS169 narrow FOV (4°×3°). Length chosen so the frustum is visible in the scene.
  const length = 4.0;
  const hx = Math.tan(halfH) * length;
  const hy = Math.tan(halfV) * length;
  const corners: V3[] = [
    [ hx,  hy, -length],
    [-hx,  hy, -length],
    [-hx, -hy, -length],
    [ hx, -hy, -length],
  ];

  // Translucent frustum volume — 4 triangular side faces.
  const frustumGeo = useMemo(() => {
    const apex: V3 = [0, 0, 0]; // apex is at the camera aperture (after the rig offset)
    const verts: number[] = [];
    for (let i = 0; i < 4; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % 4];
      verts.push(...apex, ...a, ...b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.computeVertexNormals();
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fovH, fovV]);

  const linkColor = state === 'LOCKED' ? '#8fe0b4' : state === 'TRACKING' ? '#a9d3b8' : '#d9b06a';

  // Line-of-sight from FSOC aperture to active beacon — expressed in SAT_A_POSITION's
  // local frame (all coordinates relative to SAT_A_POSITION because the parent
  // <group> is positioned at SAT_A_POSITION).
  const fsocAperture: V3 = [0, 0.22, 0]; // aperture position in SAT-01's local frame
  const toBeacon: V3 = [
    beaconWorldPos[0] - SAT_A_POSITION[0],
    beaconWorldPos[1] - SAT_A_POSITION[1],
    beaconWorldPos[2] - SAT_A_POSITION[2],
  ];

  return (
    <group position={SAT_A_POSITION}>
      {/* Virtual tracking camera body — rotates with telemetry pan/tilt.
          SAT-01 itself is stationary; only rigRef rotates. */}
      <group ref={rigRef} position={fsocAperture}>
        <mesh>
          <boxGeometry args={[0.16, 0.1, 0.22]} />
          <meshStandardMaterial color="#5a6666" metalness={0.8} roughness={0.3} />
        </mesh>
        <mesh position={[0, 0, -0.15]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.055, 0.065, 0.1, 20]} />
          <meshStandardMaterial color="#2c3a40" metalness={0.85} roughness={0.22} />
        </mesh>
        {/* Lens aperture disc */}
        <mesh position={[0, 0, -0.205]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.042, 0.042, 0.012, 20]} />
          <meshBasicMaterial color="#9fd8e8" transparent opacity={0.9} toneMapped={false} />
        </mesh>
        {showFov && (
          <group>
            <mesh geometry={frustumGeo}>
              <meshBasicMaterial color="#69b7c9" transparent opacity={0.07} side={THREE.DoubleSide} depthWrite={false} />
            </mesh>
            {corners.map((c, i) => (
              <Line key={i} points={[[0, 0, 0], c]} color="#7fc4d4" lineWidth={0.7} transparent opacity={0.55} />
            ))}
            <Line points={[...corners, corners[0]]} color="#8fd2e2" lineWidth={0.9} transparent opacity={0.75} />
            {/* Far-plane tint */}
            <mesh position={[0, 0, -length]}>
              <planeGeometry args={[hx * 2, hy * 2]} />
              <meshBasicMaterial color="#69b7c9" transparent opacity={0.05} side={THREE.DoubleSide} depthWrite={false} />
            </mesh>
            {/* Boresight */}
            <Line points={[[0, 0, 0], [0, 0, -length * 0.92]]} color="#e08a7a" lineWidth={0.8} transparent opacity={0.65} dashed dashSize={0.08} gapSize={0.06} />
          </group>
        )}
      </group>
      {showLabels && <ObjLabel text="FSOC-CAM-01" color="#9fd8e8" offset={0.62} />}
      {/* Dashed line-of-sight from FSOC aperture to active beacon */}
      <Line points={[fsocAperture, toBeacon]} color="#7fa895" lineWidth={0.5} transparent opacity={0.4} dashed dashSize={0.05} gapSize={0.05} />
      {linkActive && (
        <Line
          points={[fsocAperture, toBeacon]}
          color={linkColor}
          lineWidth={state === 'LOCKED' ? 1 : 0.6}
          transparent
          opacity={state === 'LOCKED' ? 0.8 : 0.45}
        />
      )}
    </group>
  );
}

function TrajectoryLine({ history, visible }: { history: TelemetryFrame[]; visible: boolean }) {
  const points = useMemo(
    () =>
      history.slice(-120).map(
        (f) =>
          [
            SAT_A_POSITION[0] + f.target.position.x * WORLD_SCALE,
            SAT_A_POSITION[1] + f.target.position.y * WORLD_SCALE,
            SAT_A_POSITION[2] + f.target.position.z * WORLD_SCALE,
          ] as V3,
      ),
    [history],
  );
  if (!visible || points.length < 2) return null;
  return <Line points={points} color="#8ba79e" lineWidth={0.55} transparent opacity={0.5} />;
}

// ── Beacon local offset on a target terminal (in Three.js world units) ──
// The beacon is mounted on top of the target body.
// BEACON_LOCAL_OFFSET is expressed in the target's local frame.
// When the target moves or rotates, the beacon inherits both transforms
// automatically because it is a child of the same groupRef.
const BEACON_LOCAL_OFFSET: V3 = [0, 0.62, 0];

// ── Interactive local object (visualisation-only extra) ──────────
function LocalObject({
  def,
  selected,
  gizmoMode,
  showLabels,
  showBeacon,
  onSelect,
  onMove,
  onRotate,
  onOrbitEnabled,
  reportPosition,
  reportVelocity,
}: {
  def: SceneObjectDef;
  selected: boolean;
  gizmoMode: 'translate' | 'rotate' | null;
  showLabels: boolean;
  showBeacon: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, base: V3) => void;
  onRotate: (id: string, rot: V3) => void;
  onOrbitEnabled: (enabled: boolean) => void;
  reportPosition: (id: string, p: V3) => void;
  reportVelocity: (id: string, v: V3) => void;
}) {
  // groupRef is attached directly to the single root group.
  // Both the satellite mesh AND the beacon are children of this group,
  // so the beacon is always at BEACON_LOCAL_OFFSET relative to the target —
  // it never drifts away regardless of motion mode or user drag.
  const groupRef = useRef<THREE.Group>(null!);
  const beaconRef = useRef<THREE.Group>(null!);
  const baseRef = useRef<V3>([...def.base] as V3);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (!draggingRef.current) baseRef.current = [...def.base] as V3;
  }, [def.base]);

  useFrame(() => {
    const g = groupRef.current;
    if (!g) return;
    if (draggingRef.current) {
      // While dragging, report the current world position (TransformControls
      // is moving groupRef directly, so g.position is already up-to-date).
      reportPosition(def.id, [g.position.x, g.position.y, g.position.z]);
      // Also report beacon world position so VirtualFsocRig can point at it.
      if (beaconRef.current && def.kind === 'target') {
        const bw = new THREE.Vector3();
        beaconRef.current.getWorldPosition(bw);
        reportPosition(def.beaconId, [bw.x, bw.y, bw.z]);
      }
      return;
    }
    // Wall-clock seconds — same basis as def.spawnedAt.
    const t = performance.now() / 1000;
    const off = motionOffset(def, t);
    g.position.set(
      baseRef.current[0] + off[0],
      baseRef.current[1] + off[1],
      baseRef.current[2] + off[2],
    );
    g.rotation.set(def.rotation[0], def.rotation[1], def.rotation[2]);
    reportPosition(def.id, [g.position.x, g.position.y, g.position.z]);
    reportVelocity(def.id, motionVelocity(def, t));
    // Report beacon world position so VirtualFsocRig can point at the right beacon.
    if (beaconRef.current && def.kind === 'target') {
      const bw = new THREE.Vector3();
      beaconRef.current.getWorldPosition(bw);
      reportPosition(def.beaconId, [bw.x, bw.y, bw.z]);
    }
  });

  const isTarget = def.kind === 'target';
  const accent = isTarget ? '#e0a44a' : '#73c8bd';

  return (
    <>
      {/* Single root group — groupRef drives BOTH the satellite mesh and beacon.
          The beacon is a child, so it always inherits the target's world transform.
          beaconWorldPos = targetWorldPos + targetRotation * BEACON_LOCAL_OFFSET */}
      <group
        ref={groupRef}
        position={def.base}
        rotation={def.rotation}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(def.id);
        }}
      >
        <SatelliteMesh target={isTarget} accent={selected ? '#ffffff' : accent} />
        {isTarget && showBeacon && (
          <group ref={beaconRef} position={BEACON_LOCAL_OFFSET}>
            <Beacon color="#ffd9a0" scale={0.85} />
          </group>
        )}
        {selected && (
          <mesh>
            <sphereGeometry args={[0.75, 16, 12]} />
            <meshBasicMaterial color="#e8b34a" transparent opacity={0.14} depthWrite={false} />
          </mesh>
        )}
        {showLabels && <ObjLabel text={def.label} color={isTarget ? '#f0c98a' : '#9fd8e8'} />}
      </group>
      {selected && gizmoMode && (
        <TransformControls
          object={groupRef}
          mode={gizmoMode}
          size={0.75}
          onMouseDown={() => {
            draggingRef.current = true;
            onOrbitEnabled(false);
          }}
          onMouseUp={() => {
            const g = groupRef.current;
            if (g) {
              if (gizmoMode === 'translate') {
                const t = performance.now() / 1000;
                const off = motionOffset(def, t);
                const nb: V3 = [g.position.x - off[0], g.position.y - off[1], g.position.z - off[2]];
                baseRef.current = nb;
                onMove(def.id, nb);
              } else {
                onRotate(def.id, [g.rotation.x, g.rotation.y, g.rotation.z]);
              }
            }
            draggingRef.current = false;
            onOrbitEnabled(true);
          }}
        />
      )}
    </>
  );
}

// ── Camera ownership state machine ────────────────────────────────
// FREE: OrbitControls owns the visualization camera.
// FOCUSING: a one-time focus animation owns it; on completion → FREE.
// FOLLOWING ('follow'): continuous follow owns it; toggle off → FREE.
type CameraMode = 'free' | 'focusing' | 'follow';

interface ViewRequest {
  name: 'iso' | 'top' | 'front' | 'side' | 'reset' | 'target' | 'camera';
  k: number;
}

// ── Operator view presets + follow (never touches pan/tilt) ─────
function NavRig({
  viewReq,
  cameraMode,
  setCameraMode,
  followId,
  positionsRef,
  fallback,
  orbitEnabled,
}: {
  viewReq: ViewRequest | null;
  cameraMode: CameraMode;
  setCameraMode: (mode: CameraMode) => void;
  followId: string | null;
  positionsRef: React.MutableRefObject<Map<string, V3>>;
  fallback: V3;
  orbitEnabled: boolean;
}) {
  const { camera, controls } = useThree() as unknown as { camera: THREE.Camera; controls: { target: THREE.Vector3; update: () => void; enabled: boolean } | null };
  const tmp = useMemo(() => new THREE.Vector3(), []);

  // Transition state: store FROM and TO separately so lerp is correct.
  // fromPos/fromTarget = position at the moment the transition starts.
  // toPos/toTarget     = destination position/lookAt.
  const fromPos    = useMemo(() => new THREE.Vector3(), []);
  const toPos      = useMemo(() => new THREE.Vector3(), []);
  const fromTarget = useMemo(() => new THREE.Vector3(), []);
  const toTarget   = useMemo(() => new THREE.Vector3(), []);
  const transitionStart = useRef(0);
  const isTransitioning = useRef(false);

  // Latest per-render values, mirrored into refs so the one-shot effect
  // below does NOT need them in its dependency array. Including `fallback`
  // (a fresh array every telemetry frame) or `followId` in deps would
  // re-fire this effect ~30×/sec and permanently hijack the camera.
  const followIdRef = useRef(followId);
  followIdRef.current = followId;
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const cameraModeRef = useRef(cameraMode);
  cameraModeRef.current = cameraMode;

  // Handle view requests — fires ONCE per request (viewReq object identity),
  // stores FROM/TO, starts timer. Never modifies camera.position here;
  // that is done exclusively in useFrame.
  useEffect(() => {
    if (!viewReq || !controls) return;

    // Any preset cancels follow; the transition owns the camera while running
    setCameraMode('focusing');

    // Snapshot current visualization camera state as FROM
    fromPos.copy(camera.position);
    fromTarget.copy(controls.target);

    // Compute destination TO (reads latest values via refs)
    const dest = new THREE.Vector3(0, 0, -0.55); // default lookAt
    let destCamPos: V3;
    const fid = followIdRef.current;
    const fb = fallbackRef.current;

    if (viewReq.name === 'target') {
      const p = (fid && positionsRef.current.get(fid)) || fb;
      dest.set(p[0], p[1] + 0.3, p[2]);
      destCamPos = [p[0] + 1.8, p[1] + 1.2, p[2] + 2.5];
    } else if (viewReq.name === 'camera') {
      dest.set(SAT_A_POSITION[0], SAT_A_POSITION[1] + 0.22, SAT_A_POSITION[2]);
      destCamPos = [SAT_A_POSITION[0] + 1.4, SAT_A_POSITION[1] + 0.8, SAT_A_POSITION[2] + 2.0];
    } else if (viewReq.name === 'reset') {
      dest.set(0, 0, -0.55);
      destCamPos = [4.8, 2.8, 7.4];
    } else {
      destCamPos =
        viewReq.name === 'top'   ? [0.01, 9.5, -0.54]
        : viewReq.name === 'front' ? [0, 0.7, 7.6]
        : viewReq.name === 'side'  ? [7.6, 0.9, -0.55]
        : [4.8, 2.8, 7.4]; // iso/full
    }

    toPos.set(...destCamPos);
    toTarget.copy(dest);

    // Kick off timed interpolation in useFrame
    transitionStart.current = performance.now() / 1000;
    isTransitioning.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewReq]);

  // FOLLOW — continuous, lerps the OrbitControls look-at toward the tracked object.
  // Only active when cameraMode === 'follow'. Does NOT move camera.position.
  useFrame(() => {
    if (cameraMode !== 'follow' || !controls) return;
    const p = (followId && positionsRef.current.get(followId)) || fallback;
    tmp.set(p[0], p[1], p[2]);
    controls.target.lerp(tmp, 0.06);
    controls.update();
  });

  // FOCUS transition — runs for exactly `duration` seconds after a view request,
  // then stops. Lerps FROM→TO, never writes outside this window.
  useFrame(() => {
    if (!isTransitioning.current || !controls) return;

    const elapsed = performance.now() / 1000 - transitionStart.current;
    const duration = 0.65;

    if (elapsed >= duration) {
      // Snap to exact destination, stop, return ownership to OrbitControls
      camera.position.copy(toPos);
      controls.target.copy(toTarget);
      controls.update();
      isTransitioning.current = false;
      setCameraMode('free'); // FOCUSING → FREE
      return;
    }

    // Ease-out cubic: fast start, smooth finish
    const t = elapsed / duration;
    const ease = 1 - Math.pow(1 - t, 3);

    camera.position.lerpVectors(fromPos, toPos, ease);
    controls.target.lerpVectors(fromTarget, toTarget, ease);
    controls.update();
  });

  // Keep OrbitControls.enabled in sync with camera mode.
  // FOLLOW and FOCUSING own the camera; OrbitControls owns it in FREE.
  const orbitActive = orbitEnabled && cameraMode === 'free';
  useEffect(() => {
    if (controls) {
      controls.enabled = orbitActive;
    }
  }, [controls, orbitActive]);

  return (
    <OrbitControls
      makeDefault
      enabled={orbitActive}
      enableDamping
      dampingFactor={0.075}
      minDistance={1.2}
      maxDistance={26}
      target={[0, 0, -0.55]}
    />
  );
}

// ── Scene content (inside Canvas) ────────────────────────────────
function SceneContent(props: {
  frame: TelemetryFrame | null;
  history: TelemetryFrame[];
  settings: SceneSettings;
  objects: SceneObjectDef[];
  selectedId: string | null;
  gizmoMode: 'translate' | 'rotate' | null;
  viewReq: ViewRequest | null;
  cameraMode: CameraMode;
  setCameraMode: (mode: CameraMode) => void;
  orbitEnabled: boolean;
  positionsRef: React.MutableRefObject<Map<string, V3>>;
  velocitiesRef: React.MutableRefObject<Map<string, V3>>;
  onSelect: (id: string | null) => void;
  onMove: (id: string, base: V3) => void;
  onRotate: (id: string, rot: V3) => void;
  onOrbitEnabled: (v: boolean) => void;
}) {
  const { frame, history, settings, objects, selectedId, gizmoMode } = props;

  const targetPosition: V3 = [
    SAT_A_POSITION[0] + (frame?.target.position.x ?? 120) * WORLD_SCALE,
    SAT_A_POSITION[1] + (frame?.target.position.y ?? 60) * WORLD_SCALE,
    SAT_A_POSITION[2] + (frame?.target.position.z ?? 350) * WORLD_SCALE,
  ];
  const reportPosition = (id: string, p: V3) => {
    props.positionsRef.current.set(id, p);
  };
  const reportVelocity = (id: string, v: V3) => {
    props.velocitiesRef.current.set(id, v);
  };

  const state = frame?.target_state ?? 'READY';
  const active = state !== 'READY' && state !== 'SEARCHING' && state !== 'LOST';

  useEffect(() => {
    props.positionsRef.current.set('SAT-01', SAT_A_POSITION);
    props.velocitiesRef.current.set('SAT-01', [0, 0, 0]);
  }, [props.positionsRef, props.velocitiesRef]);

  const liveId = frame?.target.id ?? 'BEACON-01';

  // Beacon for the live backend target is at BEACON_LOCAL_OFFSET above the target terminal.
  const liveBeaconWorldPos: V3 = [
    targetPosition[0] + BEACON_LOCAL_OFFSET[0],
    targetPosition[1] + BEACON_LOCAL_OFFSET[1],
    targetPosition[2] + BEACON_LOCAL_OFFSET[2],
  ];

  // Determine which beacon the FSOC camera currently points at.
  // If a user-added target is being tracked (trackingState !== 'IDLE'),
  // use its beaconId position reported by LocalObject; otherwise use the live beacon.
  const trackedLocalTarget = props.objects.find(
    (o) => o.kind === 'target' && o.trackingState !== 'IDLE',
  );
  const activeBeaconPos: V3 =
    (trackedLocalTarget && props.positionsRef.current.get(trackedLocalTarget.beaconId))
    ?? liveBeaconWorldPos;

  return (
    <>
      <color attach="background" args={[SCENE_BG]} />
      <fog attach="fog" args={[SCENE_BG, 13, 38]} />
      <SceneLights brightness={settings.brightness} />
      <StarField visible={settings.stars} />
      {/* subtle spatial reference — kept minimal so the scene reads as space, not CAD */}
      <gridHelper args={[24, 24, '#1b2c3e', '#101a26']} position={[0, -2.6, 0]} />
      <Earth brightness={settings.brightness} />

      {/* FSOC terminal satellite (host of the virtual camera) */}
      <group
        position={SAT_A_POSITION}
        onClick={(e) => {
          e.stopPropagation();
          props.onSelect('SAT-01');
        }}
      >
        <SatelliteMesh accent={selectedId === 'SAT-01' ? '#ffffff' : undefined} />
        <GimbalTerminal pan={frame?.camera.pan ?? 0} tilt={frame?.camera.tilt ?? 0} active={active} />
        {settings.labels && <ObjLabel text="SAT-01" offset={0.66} />}
        {selectedId === 'SAT-01' && (
          <mesh>
            <sphereGeometry args={[0.85, 16, 12]} />
            <meshBasicMaterial color="#e8b34a" transparent opacity={0.1} depthWrite={false} />
          </mesh>
        )}
      </group>

      {/* live backend target + beacon */}
      <group
        position={targetPosition}
        onClick={(e) => {
          e.stopPropagation();
          props.onSelect(liveId);
        }}
      >
        <SatelliteMesh target accent={selectedId === liveId ? '#ffffff' : undefined} />
        {/* Beacon is a child of the target group at BEACON_LOCAL_OFFSET —
            same offset used by LocalObject and VirtualFsocRig. */}
        <group position={BEACON_LOCAL_OFFSET}>
          <Beacon color={state === 'LOCKED' ? '#c4ffd9' : '#bfe0ff'} scale={1} />
        </group>
        {settings.labels && (
          <ObjLabel
            text={selectedId === liveId ? (liveId.startsWith('BEACON') ? 'TARGET-01' : liveId) : (liveId.startsWith('TARGET') ? liveId.replace('TARGET', 'BEACON') : liveId)}
            offset={0.48}
            color="#f0e2c4"
          />
        )}
        {selectedId === liveId && (
          <mesh>
            <sphereGeometry args={[0.85, 16, 12]} />
            <meshBasicMaterial color="#e8b34a" transparent opacity={0.1} depthWrite={false} />
          </mesh>
        )}
      </group>

      {/* virtual tracking camera + FOV (telemetry-driven) */}
      <VirtualFsocRig
        frame={frame}
        liveId={liveId}
        targetPosition={targetPosition}
        beaconWorldPos={activeBeaconPos}
        showFov={settings.fov}
        showLabels={settings.labels}
        reportPosition={reportPosition}
      />
      <TrajectoryLine history={history} visible={settings.trajectory} />

      {/* secondary live targets from multi-target mode */}
      {(frame?.targets ?? [])
        .filter((t) => !t.is_primary && t.position)
        .map((t) => {
          const p: V3 = [
            SAT_A_POSITION[0] + t.position.x * WORLD_SCALE,
            SAT_A_POSITION[1] + t.position.y * WORLD_SCALE,
            SAT_A_POSITION[2] + t.position.z * WORLD_SCALE,
          ];
          return (
            <group key={t.id} position={p}>
              <SatelliteMesh target accent="#e0a44a" />
              <group position={BEACON_LOCAL_OFFSET}>
                <Beacon color="#ffd9a0" scale={0.8} />
              </group>
              {settings.labels && <ObjLabel text={`${t.id} [SEC]`} color="#f0c98a" />}
            </group>
          );
        })}

      {/* user-added visualisation objects */}
      {objects.map((def) => (
        <LocalObject
          key={def.id}
          def={def}
          selected={selectedId === def.id}
          gizmoMode={selectedId === def.id ? gizmoMode : null}
          showLabels={settings.labels}
          showBeacon
          onSelect={props.onSelect}
          onMove={props.onMove}
          onRotate={props.onRotate}
          onOrbitEnabled={props.onOrbitEnabled}
          reportPosition={reportPosition}
          reportVelocity={reportVelocity}
        />
      ))}

      <NavRig
        viewReq={props.viewReq}
        cameraMode={props.cameraMode}
        setCameraMode={props.setCameraMode}
        followId={props.selectedId}
        positionsRef={props.positionsRef}
        fallback={targetPosition}
        orbitEnabled={props.orbitEnabled}
      />
    </>
  );
}

// ── Overlay UI styling (matches dark aerospace identity) ─────────
const panel: React.CSSProperties = {
  background: 'rgba(7,13,18,0.86)',
  border: '1px solid rgba(140,170,165,0.22)',
  fontFamily: 'monospace',
  fontSize: 10,
  color: '#cfd8d4',
  letterSpacing: '0.06em',
};
const chipBtn: React.CSSProperties = {
  ...panel,
  padding: '4px 8px',
  cursor: 'pointer',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
};
const chipOn: React.CSSProperties = { borderColor: '#d98618', color: '#f0b35a' };

let localTargetCounter = 1;
let localSatCounter = 1;

// ── Responsive Resizer for Operator Viewport ───────────────────────
function ResponsiveResizer({ containerWidth, containerHeight }: { containerWidth?: number; containerHeight?: number }) {
  const { gl, camera, size } = useThree();

  useEffect(() => {
    const w = containerWidth && containerWidth > 0 ? containerWidth : size.width;
    const h = containerHeight && containerHeight > 0 ? containerHeight : size.height;
    if (w > 0 && h > 0) {
      gl.setSize(w, h, false);
      if ('aspect' in camera) {
        (camera as THREE.PerspectiveCamera).aspect = w / h;
        camera.updateProjectionMatrix();
      }
    }
  }, [gl, camera, size.width, size.height, containerWidth, containerHeight]);

  return null;
}

// ── Main component ───────────────────────────────────────────────
interface Props {
  frame: TelemetryFrame | null;
  history: TelemetryFrame[];
}

export default function Scene3D({ frame, history }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setContainerSize({ width, height });
        }
      }
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [settings, setSettings] = useState<SceneSettings>({ brightness: 1, stars: true, fov: true, trajectory: true, labels: true });
  const [objects, setObjects] = useState<SceneObjectDef[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [gizmoMode, setGizmoMode] = useState<'translate' | 'rotate' | null>('translate');
  const [viewReq, setViewReq] = useState<ViewRequest | null>(null);
  const [cameraMode, setCameraMode] = useState<CameraMode>('free');
  const [orbitEnabled, setOrbitEnabled] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showShift, setShowShift] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [panelTick, setPanelTick] = useState<V3 | null>(null);
  const [offset, setOffset] = useState<V3>([0, 0, 0]);
  const offsetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const positionsRef = useRef<Map<string, V3>>(new Map());
  const velocitiesRef = useRef<Map<string, V3>>(new Map());

  const liveId = frame?.target.id ?? 'BEACON-01';
  const liveTargetLabel = liveId.startsWith('BEACON') ? liveId.replace('BEACON', 'TARGET') : liveId;
  const liveBeaconLabel = liveId.startsWith('TARGET') ? liveId.replace('TARGET', 'BEACON') : liveId;

  const setS = (k: keyof SceneSettings, v: number | boolean) => setSettings((p) => ({ ...p, [k]: v }));
  const requestView = (name: ViewRequest['name']) => {
    // A new preset cancels follow; the NavRig transition owns the camera
    // (FOCUSING) until it completes, then returns to FREE.
    setCameraMode('free');
    setViewReq((p) => ({ name, k: (p?.k ?? 0) + 1 }));
  };

  // ESC cancels any focus/follow and returns to FREE orbit control.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setViewReq(null);
        setCameraMode('free');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const addObject = async (kind: LocalKind) => {
    if (objects.length >= 6) return;
    const now = performance.now() / 1000;
    if (kind === 'target') {
      localTargetCounter += 1;
      const n = String(localTargetCounter).padStart(2, '0');
      // Spawn near the default target's known-good sim position (-8, 2, 350 m)
      // so it immediately maps to a valid angular position the camera can sweep to.
      // Each additional target is offset laterally in X (±40 m steps) and
      // slightly in Y so they don't stack on top of each other.
      // Three.js world = SAT_A + simPos * WORLD_SCALE
      const offsetIdx = objects.length;  // 0-based
      const simX = -8.0 + (offsetIdx % 3 - 1) * 40.0;   // −48, −8, +32 m
      const simY =  2.0 + Math.floor(offsetIdx / 3) * 20.0;
      const simZ = 350.0;
      const baseX = SAT_A_POSITION[0] + simX * WORLD_SCALE;
      const baseY = SAT_A_POSITION[1] + simY * WORLD_SCALE;
      const baseZ = SAT_A_POSITION[2] + simZ * WORLD_SCALE;
      const def: SceneObjectDef = {
        id: `XTGT-${n}`,
        kind: 'target',
        label: `TARGET-${n}`,
        displayLabel: `TARGET-${n}`,
        hostId: `SAT-${n}`,
        beaconId: `BEACON-${n}`,
        trackingState: 'IDLE',
        base: [baseX, baseY, baseZ] as V3,
        rotation: [0, 0, 0],
        motion: 'sinusoidal',
        ampH: 1.1,
        ampV: 0.45,
        period: 14,
        vel: [0, 0, 0],
        spawnedAt: now,
      };
      
      // Register with backend
      try {
        await fsocApi.registerTarget(def.displayLabel, {
          x: simX,
          y: simY,
          z: simZ,
          trajectory: 'sinusoidal',
          beacon_size_px: 10.0,
          beacon_shape: 'square',
        });
      } catch (e) {
        console.error('Failed to register target with backend', e);
      }
      
      setObjects((p) => [...p, def]);
      setSelectedId(def.id);
      setGizmoMode('translate');
    } else {
      localSatCounter += 1;
      const n = String(localSatCounter).padStart(2, '0');
      const cameraId = `FSOC-CAM-${n}`;
      const def: SceneObjectDef = {
        id: `XSAT-${n}`,
        kind: 'satellite',
        label: `SAT-${n}`,
        displayLabel: `SAT-${n}`,
        hostId: `SAT-${n}`,
        beaconId: cameraId,
        trackingState: 'IDLE',
        base: [0.6 + objects.length * 0.7, 0.5 + (objects.length % 2) * 0.5, 1.2 - objects.length * 0.4],
        rotation: [0, 0, 0],
        motion: 'static',
        ampH: 1.1,
        ampV: 0.45,
        period: 14,
        vel: [0, 0, 0],
        spawnedAt: now,
      };
      
      // Register with backend
      try {
        await fsocApi.registerSatellite(def.displayLabel, cameraId);
      } catch (e) {
        console.error('Failed to register satellite with backend', e);
      }
      
      setObjects((p) => [...p, def]);
      setSelectedId(def.id);
      setGizmoMode('translate');
    }
  };

  const updateObject = (id: string, patch: Partial<SceneObjectDef>) =>
    setObjects((p) => p.map((o) => (o.id === id ? { ...o, ...patch } : o)));

  const deleteSelected = () => {
    if (!selectedId || selectedId === 'SAT-01' || selectedId === liveId || selectedId === liveTargetLabel) return;
    setObjects((p) => p.filter((o) => o.id !== selectedId));
    positionsRef.current.delete(selectedId);
    velocitiesRef.current.delete(selectedId);
    setSelectedId(null);
  };

  const selectedLocal = objects.find((o) => o.id === selectedId) ?? null;
  const isLiveBeacon = selectedId === liveId || selectedId === liveTargetLabel || selectedId === liveBeaconLabel;
  const isLiveSat = selectedId === 'SAT-01';
  const isLiveSelection = isLiveBeacon || isLiveSat;

  // Operator target shift → POST to backend (debounced). This moves the TRUE
  // beacon world position, so the 2D feed, detection, PID and FOV all follow.
  const pushOffset = (v: V3) => {
    setOffset(v);
    if (offsetTimer.current) clearTimeout(offsetTimer.current);
    offsetTimer.current = setTimeout(() => {
      fsocApi.setTargetOffset(v[0], v[1], v[2]).catch(() => {});
    }, 250);
  };

  // poll live positions for the compact properties panel (no render storm)
  useEffect(() => {
    if (!selectedId) return;
    const t = setInterval(() => {
      const p = positionsRef.current.get(selectedId);
      if (p) setPanelTick([...p] as V3);
    }, 400);
    return () => clearInterval(t);
  }, [selectedId]);

  const livePos = selectedId ? positionsRef.current.get(selectedId) ?? null : null;
  const liveVel = selectedId ? velocitiesRef.current.get(selectedId) ?? null : null;
  const shownPos = panelTick ?? livePos;
  const backendTraj = (frame as unknown as { target_trajectory?: string })?.target_trajectory;

  const pan = frame?.camera.pan ?? 0;
  const tilt = frame?.camera.tilt ?? 0;
  const tstate = frame?.target_state ?? 'READY';

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        flex: 1,
        background: SCENE_BG,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Canvas
        camera={{ position: [4.8, 2.8, 7.4], fov: 43, near: 0.01, far: 120 }}
        gl={{ antialias: true, alpha: false, logarithmicDepthBuffer: true }}
        dpr={[1, 1.5]}
        style={{ width: '100%', height: '100%', minWidth: 0, minHeight: 0, display: 'block', flex: 1 }}
        onPointerMissed={() => {
          // Don't disrupt camera mode when follow is active
          if (cameraMode !== 'follow') {
            setSelectedId(null);
          }
        }}
      >
        <ResponsiveResizer containerWidth={containerSize?.width} containerHeight={containerSize?.height} />
        <SceneContent
          frame={frame}
          history={history}
          settings={settings}
          objects={objects}
          selectedId={selectedId}
          gizmoMode={gizmoMode}
          viewReq={viewReq}
          cameraMode={cameraMode}
          setCameraMode={setCameraMode}
          orbitEnabled={orbitEnabled}
          positionsRef={positionsRef}
          velocitiesRef={velocitiesRef}
          onSelect={setSelectedId}
          onMove={(id, base) => updateObject(id, { base })}
          onRotate={(id, rot) => updateObject(id, { rotation: rot })}
          onOrbitEnabled={setOrbitEnabled}
        />
      </Canvas>

      {/* ── overlay root (non-interactive except controls) ── */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', fontFamily: 'monospace' }}>
        {/* top-left: minimal identity (telemetry lives in the side panel) */}
        <div style={{ position: 'absolute', top: 48, left: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ ...panel, padding: '3px 8px', fontSize: 9 }}>
            <span style={{ color: '#f0b35a' }}>■ ASTERIA · 3D DIGITAL TWIN</span>
            <span style={{ color: '#626a6d' }}> · {tstate}</span>
          </div>
        </div>

        {/* top-right: scene settings */}
        <div style={{ position: 'absolute', top: 48, right: 12, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
          <button style={{ ...chipBtn, pointerEvents: 'auto', ...(showSettings ? chipOn : {}) }} onClick={() => setShowSettings((s) => !s)}>
            ⚙ SCENE
          </button>
          {showSettings && (
            <div style={{ ...panel, padding: 8, pointerEvents: 'auto', width: 178, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div>
                <div style={{ color: '#8d9195', marginBottom: 2 }}>BRIGHTNESS {(settings.brightness as number).toFixed(2)}</div>
                <input
                  type="range"
                  min={0.4}
                  max={1.6}
                  step={0.05}
                  value={settings.brightness}
                  onChange={(e) => setS('brightness', Number(e.target.value))}
                  style={{ width: '100%' }}
                />
              </div>
              {(['stars', 'fov', 'trajectory', 'labels'] as const).map((k) => (
                <label key={k} style={{ display: 'flex', justifyContent: 'space-between', cursor: 'pointer', textTransform: 'uppercase' }}>
                  <span>{k === 'fov' ? 'FOV cone' : k}</span>
                  <input type="checkbox" checked={settings[k] as boolean} onChange={(e) => setS(k, e.target.checked)} />
                </label>
              ))}
            </div>
          )}
        </div>

        {/* left: compact view controls (one-time focus presets + follow) */}
        <div style={{ position: 'absolute', left: 12, top: 100, display: 'flex', flexDirection: 'column', gap: 3 }} title="Drag to orbit · right-drag to pan · wheel to zoom">
          <div style={{ ...panel, padding: '2px 6px', color: '#8d9195', fontSize: 9 }}>VIEW</div>
          <div style={{ display: 'flex', gap: 3 }}>
            <button style={{ ...chipBtn, pointerEvents: 'auto', fontSize: 9, padding: '3px 6px' }} onClick={() => requestView('iso')} title="Full environment view">
              FULL
            </button>
            <button style={{ ...chipBtn, pointerEvents: 'auto', fontSize: 9, padding: '3px 6px' }} onClick={() => requestView('target')} title="One-time focus on selected target (visualization only)">
              TARGET
            </button>
            <button style={{ ...chipBtn, pointerEvents: 'auto', fontSize: 9, padding: '3px 6px' }} onClick={() => requestView('camera')} title="One-time focus on FSOC camera rig (visualization only)">
              CAMERA
            </button>
          </div>
          <div style={{ display: 'flex', gap: 3 }}>
            {(['top', 'front', 'side'] as const).map((v) => (
              <button key={v} style={{ ...chipBtn, pointerEvents: 'auto', fontSize: 9, padding: '3px 6px' }} onClick={() => requestView(v)} title={`${v} view (one-time)`}>
                {v.toUpperCase()}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 3 }}>
            <button
              style={{ ...chipBtn, pointerEvents: 'auto', fontSize: 9, padding: '3px 6px', ...(cameraMode === 'follow' ? chipOn : {}) }}
              onClick={() => {
                setViewReq(null);
                setCameraMode((m) => m === 'follow' ? 'free' : 'follow');
              }}
              title="Continuous visualization follow (does not affect FSOC tracking)"
            >
              ◎ FOLLOW
            </button>
            <button style={{ ...chipBtn, pointerEvents: 'auto', fontSize: 9, padding: '3px 6px' }} onClick={() => requestView('reset')} title="Reset view + free orbit (ESC works too)">
              ⟲ RESET
            </button>
          </div>
        </div>

        {/* bottom-left: objects + gizmo */}
        <div style={{ position: 'absolute', left: 8, bottom: 8, display: 'flex', flexDirection: 'column', gap: 4, maxWidth: '46%' }}>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <button style={{ ...chipBtn, pointerEvents: 'auto' }} onClick={() => addObject('target')} title="Add new remote target platform">
              + ADD TARGET
            </button>
            <button style={{ ...chipBtn, pointerEvents: 'auto' }} onClick={() => addObject('satellite')} title="Add satellite terminal">
              + ADD SAT
            </button>
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {['SAT-01', liveId, ...objects.map((o) => o.id)].map((id) => {
              const obj = objects.find((o) => o.id === id);
              const isSelected = selectedId === id || (id === liveId && isLiveBeacon);
              const label = id === 'SAT-01' ? 'SAT-01' : id === liveId ? liveTargetLabel : (obj?.displayLabel || id);
              return (
                <button
                  key={id}
                  style={{ ...chipBtn, pointerEvents: 'auto', ...(isSelected ? chipOn : {}) }}
                  onClick={() => setSelectedId(id)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* right: selected-object structured inspector */}
        {(selectedLocal || isLiveSelection) && (
          <div style={{ ...panel, position: 'absolute', right: 8, top: 96, width: 220, padding: 10, pointerEvents: 'auto', maxHeight: 'calc(100% - 150px)', overflowY: 'auto' }}>
            {/* Header: Name + Tracking State Dot */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #233544', paddingBottom: 6, marginBottom: 6 }}>
              <div style={{ color: '#f0b35a', fontWeight: 600, fontSize: 13 }}>
                {isLiveBeacon ? liveTargetLabel : isLiveSat ? 'SAT-01' : (selectedLocal?.displayLabel || selectedId)}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
                <span
                  style={{
                    display: 'inline-block',
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    backgroundColor: isLiveBeacon
                      ? (tstate === 'LOCKED' ? '#8fe0b4' : tstate === 'TRACKING' ? '#ffd9a0' : tstate === 'LOST' ? '#e08a7a' : '#9fd8e8')
                      : isLiveSat
                        ? '#7fc4d4'
                        : selectedLocal?.trackingState === 'TRACKING' ? '#ffd9a0' : selectedLocal?.trackingState === 'LOCKED' ? '#8fe0b4' : '#6f828a',
                  }}
                />
                <span style={{ color: '#8fa9a1', textTransform: 'uppercase' }}>
                  {isLiveBeacon ? tstate : isLiveSat ? 'ONLINE' : (selectedLocal?.trackingState ?? 'IDLE')}
                </span>
              </div>
            </div>

            {/* Entity Hierarchy Section */}
            <div style={{ borderBottom: '1px solid #233544', paddingBottom: 6, marginBottom: 6 }}>
              <PropRow label="HOST" value={isLiveBeacon ? 'SAT-02' : isLiveSat ? 'LOCAL TERMINAL' : (selectedLocal?.hostId ?? 'SAT-02')} />
              <PropRow label="BEACON" value={isLiveBeacon ? liveBeaconLabel : isLiveSat ? 'FSOC-CAM-01' : (selectedLocal?.beaconId ?? 'BEACON-02')} />
            </div>

            {/* Position & Velocity */}
            <div style={{ borderBottom: '1px solid #233544', paddingBottom: 6, marginBottom: 6 }}>
              <div style={{ color: '#8d9195', fontSize: 10, marginBottom: 2 }}>POSITION (WORLD)</div>
              {isLiveBeacon ? (
                <>
                  <PropRow label="X" value={`${(frame?.target.position.x ?? 0).toFixed(2)} m`} />
                  <PropRow label="Y" value={`${(frame?.target.position.y ?? 0).toFixed(2)} m`} />
                  <PropRow label="Z" value={`${(frame?.target.position.z ?? 0).toFixed(2)} m`} />
                </>
              ) : isLiveSat ? (
                <>
                  <PropRow label="X" value={`${SAT_A_POSITION[0].toFixed(2)} m`} />
                  <PropRow label="Y" value={`${SAT_A_POSITION[1].toFixed(2)} m`} />
                  <PropRow label="Z" value={`${SAT_A_POSITION[2].toFixed(2)} m`} />
                </>
              ) : (
                <>
                  <PropRow label="X" value={`${shownPos ? ((shownPos[0] - SAT_A_POSITION[0]) / WORLD_SCALE).toFixed(2) : '0.00'} m`} />
                  <PropRow label="Y" value={`${shownPos ? ((shownPos[1] - SAT_A_POSITION[1]) / WORLD_SCALE).toFixed(2) : '0.00'} m`} />
                  <PropRow label="Z" value={`${shownPos ? Math.max(50, (shownPos[2] - SAT_A_POSITION[2]) / WORLD_SCALE).toFixed(2) : '350.00'} m`} />
                </>
              )}

              <div style={{ color: '#8d9195', fontSize: 10, marginTop: 4, marginBottom: 2 }}>VELOCITY</div>
              {isLiveBeacon ? (
                <>
                  <PropRow label="X" value={`${(frame?.target.velocity.x ?? 0).toFixed(2)} m/s`} />
                  <PropRow label="Y" value={`${(frame?.target.velocity.y ?? 0).toFixed(2)} m/s`} />
                  <PropRow label="Z" value={`${(frame?.target.velocity.z ?? 0).toFixed(2)} m/s`} />
                </>
              ) : isLiveSat ? (
                <PropRow label="STATIC" value="0.00 m/s" />
              ) : (
                <>
                  <PropRow label="X" value={`${liveVel ? (liveVel[0] / WORLD_SCALE * 0.05).toFixed(2) : '0.00'} m/s`} />
                  <PropRow label="Y" value={`${liveVel ? (liveVel[1] / WORLD_SCALE * 0.05).toFixed(2) : '0.00'} m/s`} />
                  <PropRow label="Z" value={`${liveVel ? (liveVel[2] / WORLD_SCALE * 0.05).toFixed(2) : '0.00'} m/s`} />
                </>
              )}
            </div>

            {/* Motion Mode Section */}
            {selectedLocal && selectedLocal.kind === 'target' && (
              <div style={{ borderBottom: '1px solid #233544', paddingBottom: 6, marginBottom: 6 }}>
                <div style={{ color: '#8d9195', fontSize: 10, marginBottom: 3 }}>MOTION</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}>
                  {MOTION_MODES.map((m) => (
                    <button
                      key={m}
                      style={{
                        ...chipBtn,
                        padding: '3px 4px',
                        fontSize: 9,
                        pointerEvents: 'auto',
                        textAlign: 'center',
                        ...(selectedLocal.motion === m ? chipOn : {}),
                      }}
                      onClick={() => updateObject(selectedLocal.id, { motion: m, spawnedAt: performance.now() / 1000 })}
                    >
                      {m === 'figure8' ? 'FIG-8' : m.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {isLiveBeacon && (
              <div style={{ borderBottom: '1px solid #233544', paddingBottom: 6, marginBottom: 6 }}>
                <PropRow label="MOTION" value={((backendTraj as string) || 'LIVE TRAJECTORY').toUpperCase()} />
                <PropRow label="TRACKING" value={tstate} />
              </div>
            )}

            {isLiveSat && (
              <div style={{ borderBottom: '1px solid #233544', paddingBottom: 6, marginBottom: 6 }}>
                <PropRow label="PAN" value={`${pan.toFixed(2)}°`} />
                <PropRow label="TILT" value={`${tilt.toFixed(2)}°`} />
                <PropRow label="FOV" value={frame ? `${frame.camera.fov_h}°×${frame.camera.fov_v}°` : '4°×3°'} />
              </div>
            )}

            {/* Action Buttons: TRACK TARGET & FOCUS TARGET */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
              {selectedLocal && selectedLocal.kind === 'target' && (
                <button
                  style={{
                    ...chipBtn,
                    pointerEvents: 'auto',
                    backgroundColor: '#1b382d',
                    borderColor: '#4eb483',
                    color: '#8fe0b4',
                    fontWeight: 600,
                    textAlign: 'center',
                    padding: '6px 8px',
                  }}
                  disabled={switching}
                  onClick={async () => {
                    setSwitching(true);
                    try {
                      const curP = positionsRef.current.get(selectedLocal.id) || selectedLocal.base;
                      const t = performance.now() / 1000;
                      const vel3d = motionVelocity(selectedLocal, t);

                      // Convert Three.js world → simulation metres.
                      // Z is clamped to ≥200 m so the target is deep enough
                      // for the 4°×3° FOV to contain it at any reasonable
                      // pan/tilt. Shallower targets subtend angles larger
                      // than the FOV and project() returns null immediately.
                      const simX = (curP[0] - SAT_A_POSITION[0]) / WORLD_SCALE;
                      const simY = (curP[1] - SAT_A_POSITION[1]) / WORLD_SCALE;
                      const simZ = Math.max(200, Math.abs((curP[2] - SAT_A_POSITION[2]) / WORLD_SCALE));

                      // Velocity: motionVelocity gives Three.js-space units/s.
                      // Scale by WORLD_SCALE to get m/s in sim space.
                      const simVx = vel3d[0] / WORLD_SCALE;
                      const simVy = vel3d[1] / WORLD_SCALE;

                      // Map frontend motion names to backend trajectory names
                      const trajMap: Record<string, string> = {
                        static: 'static',
                        straight: 'linear',
                        circular: 'circular',
                        figure8: 'figure_8',
                        random: 'random_walk',
                        spiral: 'sinusoidal',
                        sinusoidal: 'sinusoidal',
                      };
                      const trajectory = trajMap[selectedLocal.motion] ?? 'static';

                      await fsocApi.switchTarget({
                        target_id: selectedLocal.displayLabel,
                        position: { x: simX, y: simY, z: simZ },
                        velocity: { x: simVx, y: simVy, z: 0 },
                        trajectory,
                        beacon_offset: { x: 0, y: 0, z: 0 },
                      });
                      setObjects((prev) =>
                        prev.map((o) =>
                          o.id === selectedLocal.id ? { ...o, trackingState: 'TRACKING' } : { ...o, trackingState: 'IDLE' }
                        )
                      );
                    } catch (e) {
                      console.error('Failed to switch target', e);
                    } finally {
                      setSwitching(false);
                    }
                  }}
                >
                  {switching ? 'SWITCHING…' : '🎯 TRACK TARGET'}
                </button>
              )}

              {isLiveBeacon && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {/* REACQUIRE — works from any state including TARGET LOST */}
                  <button
                    style={{
                      ...chipBtn,
                      pointerEvents: 'auto',
                      backgroundColor: tstate === 'LOST' || tstate === 'REACQUIRING' ? '#2a1e10' : '#162832',
                      borderColor: tstate === 'LOST' || tstate === 'REACQUIRING' ? '#e39a32' : '#385764',
                      color: tstate === 'LOST' || tstate === 'REACQUIRING' ? '#f0c070' : '#8fa9a1',
                      fontWeight: tstate === 'LOST' ? 600 : 400,
                      fontSize: 10,
                      textAlign: 'center',
                      padding: '5px 8px',
                    }}
                    onClick={() => fsocApi.reacquire().catch(console.error)}
                  >
                    ⟳ REACQUIRE
                  </button>
                  {/* STOP TRACKING */}
                  <button
                    style={{
                      ...chipBtn,
                      pointerEvents: 'auto',
                      backgroundColor: '#1e1212',
                      borderColor: '#7a4040',
                      color: '#c98a8a',
                      fontSize: 10,
                      textAlign: 'center',
                      padding: '5px 8px',
                    }}
                    onClick={() => fsocApi.stopSimulation().catch(console.error)}
                  >
                    ■ STOP TRACKING
                  </button>
                  {/* RESET TRACKING */}
                  <button
                    style={{
                      ...chipBtn,
                      pointerEvents: 'auto',
                      backgroundColor: '#121820',
                      borderColor: '#4a6070',
                      color: '#7a9ab0',
                      fontSize: 10,
                      textAlign: 'center',
                      padding: '5px 8px',
                    }}
                    onClick={() => fsocApi.resetSimulation().catch(console.error)}
                  >
                    ↺ RESET TRACKING
                  </button>
                </div>
              )}

              <button
                style={{
                  ...chipBtn,
                  pointerEvents: 'auto',
                  borderColor: '#7fc4d4',
                  color: '#9fd8e8',
                  textAlign: 'center',
                  padding: '5px 8px',
                }}
                onClick={() => {
                  if (isLiveSat) {
                    requestView('camera');
                  } else {
                    requestView('target');
                  }
                }}
              >
                🔍 {isLiveSat ? 'FOCUS TERMINAL' : 'FOCUS TARGET'}
              </button>

              {/* Collapsible fine-tuning: 3D shift for live beacon, gizmo for local */}
              {isLiveBeacon && (
                <div style={{ marginTop: 4 }}>
                  <button
                    style={{ ...chipBtn, width: '100%', fontSize: 9, padding: '2px 4px', color: '#8d9195' }}
                    onClick={() => setShowShift((s) => !s)}
                  >
                    {showShift ? '▾ HIDE 3D SHIFT' : '▸ 3D SHIFT → LOOP (m)'}
                  </button>
                  {showShift && (
                    <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {(['X', 'Y', 'Z'] as const).map((ax, i) => (
                        <div key={ax}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9 }}>
                            <span style={{ color: '#8d9195' }}>{ax}</span>
                            <span>{offset[i].toFixed(1)}</span>
                          </div>
                          <input
                            type="range"
                            min={-30}
                            max={30}
                            step={0.5}
                            value={offset[i]}
                            onChange={(e) => {
                              const v: V3 = [...offset] as V3;
                              v[i] = Number(e.target.value);
                              pushOffset(v);
                            }}
                            style={{ width: '100%' }}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {selectedLocal && (
                <div style={{ display: 'flex', gap: 3, marginTop: 4 }}>
                  <button
                    style={{ ...chipBtn, flex: 1, padding: '3px 2px', fontSize: 9, pointerEvents: 'auto', ...(gizmoMode === 'translate' ? chipOn : {}) }}
                    onClick={() => setGizmoMode((m) => (m === 'translate' ? null : 'translate'))}
                  >
                    ✥ MOVE
                  </button>
                  <button
                    style={{ ...chipBtn, flex: 1, padding: '3px 2px', fontSize: 9, pointerEvents: 'auto', ...(gizmoMode === 'rotate' ? chipOn : {}) }}
                    onClick={() => setGizmoMode((m) => (m === 'rotate' ? null : 'rotate'))}
                  >
                    ⟳ ROT
                  </button>
                  <button
                    style={{ ...chipBtn, padding: '3px 6px', fontSize: 9, pointerEvents: 'auto', color: '#c98a7a' }}
                    onClick={deleteSelected}
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* bottom-right: subtle legend only (interaction hint lives in VIEW tooltip) */}
        <div style={{ position: 'absolute', right: 8, bottom: 8, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
          <div style={{ ...panel, padding: '3px 8px', display: 'flex', gap: 8, fontSize: 9, opacity: 0.85 }}>
            <span><span style={{ color: '#dff2ff' }}>●</span> BEACON</span>
            <span><span style={{ color: '#7fc4d4' }}>◆</span> FOV</span>
            <span><span style={{ color: '#8ba79e' }}>─</span> TRAJ</span>
            <span><span style={{ color: '#8fe0b4' }}>─</span> LINK</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function PropRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, marginTop: 2 }}>
      <span style={{ color: '#8d9195' }}>{label}</span>
      <span style={{ color: '#dfe6e2', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
    </div>
  );
}

export function SimulationViewport({ frame, history }: Props) {
  return <Scene3D frame={frame} history={history} />;
}
