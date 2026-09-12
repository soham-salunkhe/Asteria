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
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, Line, OrbitControls, TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import { fsocApi } from '../../services/fsocApi';
import { computeTrackingSync, videoBeaconMarker, opticalForward } from '../../utils/trackingSync';
import type { SimulationEntity, TelemetryFrame } from '../../types/fsoc';

// ── World constants (unchanged mapping) ──────────────────────────
const WORLD_SCALE = 0.008;

// Finite-value guard for telemetry → world mapping. A single NaN/Infinity
// in a position would silently unmount that Object3D (Three.js culls NaN
// matrices), making exactly one entity vanish while everything else
// renders. Fall back to a safe default and warn once instead.
let warnedNonFinitePosition = false;
function finiteOr(v: unknown, fallback: number, what: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (!warnedNonFinitePosition) {
    warnedNonFinitePosition = true;
    console.error(`[ASTERIA STATE ERROR] non-finite ${what} in telemetry; using fallback`, v);
  }
  return fallback;
}
const SAT_A_POSITION: [number, number, number] = [0.15, 0.1, 0.15];
// Background context only: kept off the +Z optical path and small enough
// (~18% of viewport height) not to compete with the tracking subjects.
const EARTH_POSITION: [number, number, number] = [-5.2, -2.0, -7.6];
const EARTH_RADIUS = 1.28;
const SCENE_BG = '#101a29'; // deep-space navy — dark, but objects stay distinguishable
const DEFAULT_TARGET: [number, number, number] = [0.15 + 120 * WORLD_SCALE, 0.1 + 60 * WORLD_SCALE, 0.15 + 350 * WORLD_SCALE];

type V3 = [number, number, number];
type MotionMode = 'static' | 'straight' | 'circular' | 'figure8' | 'random' | 'spiral' | 'sinusoidal';
type LocalKind = 'target' | 'satellite';

interface SceneObjectDef {
  id: string;
  kind: LocalKind;
  type: LocalKind;
  label: string;
  displayLabel: string;
  hostId: string;
  beaconId: string;
  /** User-facing name only; IDs and type relationships remain immutable. */
  beaconLabel: string;
  /** Stable camera relationship for target → host satellite → camera resolution. */
  cameraId: string;
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

function makeCloudTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < 120; i += 1) {
    const x = (i * 197.3) % canvas.width;
    const y = 60 + ((i * 83.7) % 390);
    const width = 30 + ((i * 31) % 150);
    const height = 5 + ((i * 17) % 22);
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, width);
    gradient.addColorStop(0, 'rgba(255,255,255,0.38)');
    gradient.addColorStop(0.6, 'rgba(240,248,255,0.12)');
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

// Day-side Earth surface: deep-blue oceans, fbm continents with elevation
// tinting, and noisy polar ice caps. Deterministic (seeded) so every load
// looks identical. Used as the opaque diffuse map; /earth.png (local asset)
// serves as the dim emissive night layer instead.
function makeEarthDayTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  let seed = 20260912;
  const rand = () => { seed = (seed * 16807 + 0) % 2147483647; return seed / 2147483647; };
  // Small value-noise lattice with seamless horizontal wrap
  const GW = 48;
  const GH = 24;
  const lat: number[] = [];
  for (let i = 0; i < GW * GH; i++) lat.push(rand());
  const at = (ix: number, iy: number) => lat[(((iy % GH) + GH) % GH) * GW + (((ix % GW) + GW) % GW)];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const noise = (x: number, y: number) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = smooth(x - ix);
    const fy = smooth(y - iy);
    const a = at(ix, iy);
    const b = at(ix + 1, iy);
    const c = at(ix, iy + 1);
    const d = at(ix + 1, iy + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  const fbm = (x: number, y: number) => (
    noise(x, y) * 0.55 + noise(x * 2.1 + 7.3, y * 2.1 + 3.1) * 0.27 + noise(x * 4.3 + 13.7, y * 4.3 + 9.2) * 0.18
  );
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let py = 0; py < H; py++) {
    const ny = py / H; // 0 = north pole
    const latAbs = Math.abs(ny - 0.5) * 2;
    for (let px = 0; px < W; px++) {
      const nx = px / W;
      // Domain-warped continent field
      const wx = nx * 9;
      const wy = ny * 9;
      const warp = fbm(wx * 0.5 + 3.0, wy * 0.5 + 8.0);
      const h = fbm(wx + warp * 2.2, wy + warp * 2.2);
      const i = (py * W + px) * 4;
      // Polar ice with a noisy edge
      const ice = latAbs > 0.86 + (h - 0.5) * 0.12;
      if (ice) {
        d[i] = 232; d[i + 1] = 238; d[i + 2] = 242; d[i + 3] = 255;
        continue;
      }
      if (h > 0.54) {
        // Land: elevation + moisture variation (green lowlands → tan highlands)
        const e = Math.min(1, (h - 0.54) * 4);
        const m = fbm(wx * 1.7 + 40.0, wy * 1.7 + 21.0);
        const r = 52 + e * 110 + m * 30 - latAbs * 12;
        const g = 104 - e * 28 + m * 22 - latAbs * 18;
        const b = 52 - e * 14 + m * 12;
        d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
      } else {
        // Ocean: deep blue, darker at depth and toward the poles, subtle swell
        const depth = Math.min(1, (0.54 - h) * 3);
        const swell = (fbm(wx * 3.0 + 90.0, wy * 3.0 + 45.0) - 0.5) * 10;
        d[i] = 13 + swell * 0.4;
        d[i + 1] = 44 - depth * 12 + swell * 0.5 - latAbs * 8;
        d[i + 2] = 86 - depth * 22 + swell * 0.6 - latAbs * 10;
        d[i + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
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

// Moon procedural texture
function makeMoonTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#b8b0a8';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let seed = 137;
  const rand = () => { seed = (seed * 16807 + 0) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 60; i++) {
    const x = rand() * canvas.width;
    const y = rand() * canvas.height;
    const r = 8 + rand() * 30;
    const darkness = 0.06 + rand() * 0.12;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(80,75,70,${darkness})`);
    g.addColorStop(1, 'rgba(80,75,70,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const maria = [
    { x: 180, y: 100, rx: 50, ry: 35 },
    { x: 280, y: 130, rx: 40, ry: 45 },
    { x: 350, y: 90, rx: 35, ry: 25 },
  ];
  maria.forEach(({ x, y, rx, ry }) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry));
    g.addColorStop(0, 'rgba(70,65,60,0.25)');
    g.addColorStop(1, 'rgba(70,65,60,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Fresnel atmosphere shader material
const atmosphereVertexShader = `
  varying vec3 vNormal;
  varying vec3 vPosition;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const atmosphereFragmentShader = `
  varying vec3 vNormal;
  varying vec3 vPosition;
  uniform vec3 uColor;
  uniform float uIntensity;
  void main() {
    vec3 viewDir = normalize(-vPosition);
    float fresnel = 1.0 - clamp(dot(viewDir, vNormal), 0.0, 1.0);
    fresnel = pow(fresnel, 2.5) * uIntensity;
    gl_FragColor = vec4(uColor, clamp(fresnel * 0.75, 0.0, 1.0));
  }
`;

// ── Sun position (shared by lights and Sun visual) ──────────────
const SUN_POSITION: [number, number, number] = [-8, 5, 6];

// ── Lighting rig (controlled, aerospace — never game-bright) ─────
function SceneLights({ brightness }: { brightness: number }) {
  const b = brightness;
  return (
    <group>
      <ambientLight intensity={0.35 * b} color="#8aa0b0" />
      <hemisphereLight args={['#4a6578', '#060810', 0.45 * b]} />
      {/* key / sun — warm directional */}
      <directionalLight position={SUN_POSITION} intensity={2.2 * b} color="#fff4e0" />
      {/* cool rim from behind-below so dark bodies separate from the bg */}
      <directionalLight position={[4, -1.5, -4]} intensity={0.6 * b} color="#6fa8c8" />
      {/* gentle top fill */}
      <directionalLight position={[1, 5, 1]} intensity={0.25 * b} color="#c0d0d8" />
    </group>
  );
}

// ── Dense starfield with varied brightness and size ───────────────
function StarField({ visible }: { visible: boolean }) {
  const { geometry, shaderMat } = useMemo(() => {
    const N = 2500;
    const posArr = new Float32Array(N * 3);
    const sizeArr = new Float32Array(N);
    const opacArr = new Float32Array(N);
    let seed = 31415;
    const rand = () => { seed = (seed * 16807 + 0) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < N; i++) {
      const phi = Math.acos(1 - 2 * rand());
      const theta = rand() * Math.PI * 2;
      const radius = 45 + rand() * 15;
      posArr[i * 3]     = radius * Math.sin(phi) * Math.cos(theta);
      posArr[i * 3 + 1] = radius * Math.cos(phi);
      posArr[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
      const brightness = rand();
      sizeArr[i] = brightness < 0.92 ? 0.02 + rand() * 0.04 : 0.05 + rand() * 0.06;
      opacArr[i] = 0.25 + brightness * 0.75;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizeArr, 1));
    geo.setAttribute('aOpacity', new THREE.BufferAttribute(opacArr, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: `
        attribute float aSize;
        attribute float aOpacity;
        varying float vOpacity;
        void main() {
          vOpacity = aOpacity;
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPos;
          gl_PointSize = aSize * (180.0 / -mvPos.z);
        }
      `,
      fragmentShader: `
        varying float vOpacity;
        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;
          float alpha = smoothstep(0.5, 0.15, d) * vOpacity;
          gl_FragColor = vec4(0.88, 0.92, 0.95, alpha);
        }
      `,
    });
    return { geometry: geo, shaderMat: mat };
  }, []);

  if (!visible) return null;
  return <points geometry={geometry} material={shaderMat} />;
}

// ── Sun visual — bright sphere + glow sprite (environmental only) ─
function SunVisual() {
  const glow = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, 'rgba(255,250,230,1)');
    g.addColorStop(0.15, 'rgba(255,240,200,0.6)');
    g.addColorStop(0.4, 'rgba(255,220,160,0.15)');
    g.addColorStop(0.7, 'rgba(255,200,120,0.04)');
    g.addColorStop(1, 'rgba(255,180,80,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    return new THREE.CanvasTexture(c);
  }, []);

  return (
    <group position={SUN_POSITION}>
      {/* Small bright disk — illumination comes from the directional light */}
      <mesh>
        <sphereGeometry args={[0.15, 16, 12]} />
        <meshBasicMaterial color="#fffbe8" toneMapped={false} />
      </mesh>
      {/* Very subtle glow, no bloom */}
      <sprite scale={[2.0, 2.0, 1]}>
        <spriteMaterial
          map={glow}
          color="#fff8e0"
          transparent
          opacity={0.45}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </sprite>
    </group>
  );
}

// ── Moon — background celestial body (environmental only) ────────
function Moon() {
  const moonTex = useMemo(() => makeMoonTexture(), []);
  const moonRef = useRef<THREE.Mesh>(null!);

  useFrame(({ clock }) => {
    if (moonRef.current) {
      const t = clock.elapsedTime * 0.008;
      moonRef.current.position.set(
        8 + Math.cos(t) * 2,
        3.5 + Math.sin(t * 0.7) * 0.5,
        -12 + Math.sin(t) * 2,
      );
    }
  });

  return (
    <mesh ref={moonRef} position={[8, 3.5, -12]}>
      <sphereGeometry args={[0.35, 32, 24]} />
      <meshStandardMaterial
        map={moonTex}
        roughness={0.95}
        metalness={0.0}
      />
    </mesh>
  );
}

function Earth({ brightness }: { brightness: number }) {
  // /earth.png is a gold night-render, so it serves as the dim emissive
  // night layer (washed out on the day side, glowing tracery on the dark
  // side). Loaded asynchronously without triggering React Suspense.
  const [earthTexture, setEarthTexture] = useState<THREE.Texture | null>(null);
  const dayTexture = useMemo(() => makeEarthDayTexture(), []);

  useEffect(() => {
    let active = true;
    const loader = new THREE.TextureLoader();
    loader.load(
      '/earth.png',
      (tex) => {
        if (!active) return;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        setEarthTexture(tex);
      },
      undefined,
      (err) => {
        console.warn('Could not load /earth.png, using procedural fallback', err);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const clouds = useMemo(() => makeCloudTexture(), []);
  const cloudRef = useRef<THREE.Mesh>(null!);
  const earthRef = useRef<THREE.Mesh>(null!);

  // Atmosphere Fresnel shader material
  const atmosMat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: atmosphereVertexShader,
    fragmentShader: atmosphereFragmentShader,
    uniforms: {
      uColor: { value: new THREE.Color('#4da6d9') },
      uIntensity: { value: 1.2 },
    },
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }), []);

  useFrame((_, dt) => {
    if (cloudRef.current) cloudRef.current.rotation.y += dt * 0.015;
    if (earthRef.current) earthRef.current.rotation.y += dt * 0.005;
  });

  return (
    <group position={EARTH_POSITION}>
      {/* Surface — opaque day texture; local /earth.png asset glows dimly
          as the night-side layer only (washed out where sunlit) */}
      <mesh ref={earthRef}>
        <sphereGeometry args={[EARTH_RADIUS, 64, 48]} />
        <meshStandardMaterial
          map={dayTexture}
          color="#ffffff"
          roughness={0.82}
          metalness={0.02}
          emissiveMap={earthTexture ?? undefined}
          emissive="#ffcf90"
          emissiveIntensity={0.22 * brightness}
        />
      </mesh>
      {/* Cloud layer — independently rotating */}
      <mesh ref={cloudRef} scale={1.008}>
        <sphereGeometry args={[EARTH_RADIUS, 64, 48]} />
        <meshStandardMaterial
          map={clouds ?? undefined}
          transparent
          opacity={0.35}
          depthWrite={false}
          roughness={1}
        />
      </mesh>
      {/* Fresnel atmosphere — thin blue rim */}
      <mesh scale={1.04} material={atmosMat}>
        <sphereGeometry args={[EARTH_RADIUS, 48, 32]} />
      </mesh>
      {/* Outer atmospheric haze — very subtle */}
      <mesh scale={1.10}>
        <sphereGeometry args={[EARTH_RADIUS, 48, 32]} />
        <meshBasicMaterial
          color="#3a8ab8"
          transparent
          opacity={0.04 * brightness}
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
    <Html center distanceFactor={12} position={[0, offset, 0]} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
      <div
        style={{
          fontFamily: 'monospace',
          fontSize: 8,
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
        <meshStandardMaterial
          color={target ? '#5c686b' : '#454f52'}
          metalness={0.72}
          roughness={0.34}
          emissive={target ? '#1a2022' : '#141a1c'}
          emissiveIntensity={0.3}
        />
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

  // Same +Z optical convention as VirtualFsocRig: yaw about Y, pitch about X
  // (positive tilt looks up toward +Y).
  useFrame((_, dt) => {
    if (!panRef.current || !tiltRef.current) return;
    if (panRef.current.rotation.order !== 'YXZ') panRef.current.rotation.order = 'YXZ';
    panRef.current.rotation.y = THREE.MathUtils.damp(panRef.current.rotation.y, targetPan, 7, dt);
    tiltRef.current.rotation.x = THREE.MathUtils.damp(tiltRef.current.rotation.x, -targetTilt, 7, dt);
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
          <mesh position={[0, 0.08, 0.16]} rotation={[0, Math.PI / 2, 0]}>
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
// Co-located with its target's group origin (the simulated beacon point),
// so the marker sits exactly on the FOV centerline when locked. Depth
// testing is off so the marker reads through the satellite bus from every
// viewer angle — a tracking-glyph convention, not scene geometry.
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
      <mesh ref={coreRef} renderOrder={999}>
        <sphereGeometry args={[0.045 * scale, 16, 12]} />
        <meshBasicMaterial color="#ffffff" toneMapped={false} depthTest={false} />
      </mesh>
      <mesh renderOrder={999}>
        <sphereGeometry args={[0.075 * scale, 16, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.85} toneMapped={false} depthTest={false} />
      </mesh>
      <sprite ref={spriteRef} renderOrder={999}>
        <spriteMaterial map={glow} color={color} transparent opacity={0.5} blending={THREE.AdditiveBlending} depthWrite={false} depthTest={false} />
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
  cameraId,
  hostPosition,
  targetPosition,
  beaconWorldPos,
  showFov,
  showLabels,
  showDebugVectors = true,
  inFront,
  reportPosition,
  onSelect,
}: {
  frame: TelemetryFrame | null;
  cameraId: string;
  hostPosition: V3;
  targetPosition: V3;
  beaconWorldPos: V3;   // world position of the ACTIVE beacon
  showFov: boolean;
  showLabels: boolean;
  showDebugVectors?: boolean;
  /** Whether the beacon is in the forward hemisphere of the FSOC camera. */
  inFront: boolean | null;
  reportPosition: (id: string, p: V3) => void;
  onSelect: (id: string) => void;
}) {
  const pan = frame?.camera.pan ?? 0;
  const tilt = frame?.camera.tilt ?? 0;
  const fovH = frame?.camera.fov_h ?? 4;
  const fovV = frame?.camera.fov_v ?? 3;
  const state = frame?.target_state ?? 'READY';
  const linkActive = state === 'ACQUIRING' || state === 'TRACKING' || state === 'LOCKED' || state === 'REACQUIRING';

  // Two-axis gimbal: PAN (Azimuth, rotates around Y) -> TILT (Elevation, rotates around X)
  const panGroupRef = useRef<THREE.Group>(null!);
  const tiltGroupRef = useRef<THREE.Group>(null!);
  const targetPan = THREE.MathUtils.degToRad(pan);
  const targetTilt = THREE.MathUtils.degToRad(tilt);

  useFrame((_, dt) => {
    if (panGroupRef.current) {
      panGroupRef.current.rotation.y = THREE.MathUtils.damp(panGroupRef.current.rotation.y, targetPan, 9, dt);
    }
    if (tiltGroupRef.current) {
      tiltGroupRef.current.rotation.x = THREE.MathUtils.damp(tiltGroupRef.current.rotation.x, -targetTilt, 9, dt);
    }
  });

  const fsocAperture: V3 = [0, 0.22, 0]; // aperture in SAT-01's local frame

  useEffect(() => {
    // Report the live target position so NavRig FOLLOW/FOCUS can track it.
    reportPosition(cameraId, [hostPosition[0] + fsocAperture[0], hostPosition[1] + fsocAperture[1], hostPosition[2] + fsocAperture[2]]);
  }, [targetPosition, reportPosition, cameraId, hostPosition]);

  const halfH = THREE.MathUtils.degToRad(fovH / 2);
  const halfV = THREE.MathUtils.degToRad(fovV / 2);
  // PS169 narrow FOV (4°×3°).
  const length = 4.0;
  const hx = Math.tan(halfH) * length;
  const hy = Math.tan(halfV) * length;
  const corners: V3[] = [
    [ hx,  hy, length],
    [-hx,  hy, length],
    [-hx, -hy, length],
    [ hx, -hy, length],
  ];

  // Translucent frustum volume — 4 triangular side faces.
  const frustumGeo = useMemo(() => {
    const apex: V3 = [0, 0, 0];
    const verts: number[] = [];
    const mHalfH = THREE.MathUtils.degToRad(fovH / 2);
    const mHalfV = THREE.MathUtils.degToRad(fovV / 2);
    const mHx = Math.tan(mHalfH) * length;
    const mHy = Math.tan(mHalfV) * length;
    const mCorners: V3[] = [
      [ mHx,  mHy, length],
      [-mHx,  mHy, length],
      [-mHx, -mHy, length],
      [ mHx, -mHy, length],
    ];
    for (let i = 0; i < 4; i++) {
      const a = mCorners[i];
      const b = mCorners[(i + 1) % 4];
      verts.push(...apex, ...a, ...b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.computeVertexNormals();
    return g;
  }, [fovH, fovV]);

  // Optical forward and vectors for debug visualization
  const fwdDir = opticalForward(pan, tilt);
  const beaconLocal: V3 = [
    beaconWorldPos[0] - hostPosition[0],
    beaconWorldPos[1] - hostPosition[1],
    beaconWorldPos[2] - hostPosition[2],
  ];
  const vecToBeacon: V3 = [
    beaconLocal[0] - fsocAperture[0],
    beaconLocal[1] - fsocAperture[1],
    beaconLocal[2] - fsocAperture[2],
  ];
  const distToBeacon = Math.hypot(...vecToBeacon);
  const dirToBeacon: V3 = distToBeacon > 1e-4
    ? [vecToBeacon[0] / distToBeacon, vecToBeacon[1] / distToBeacon, vecToBeacon[2] / distToBeacon]
    : [0, 0, 1];
  const D2R = Math.PI / 180;
  const cameraUp: V3 = [
    -Math.sin(pan * D2R) * Math.sin(tilt * D2R),
    Math.cos(tilt * D2R),
    -Math.cos(pan * D2R) * Math.sin(tilt * D2R),
  ];

  // Subtle optical-axis beam: short, thin cylinder co-located with the
  // tilt group so it inherits the exact optical frame (follows pan/tilt,
  // never aims independently). Visualization only — it indicates direction,
  // never reaches for the beacon.
  const beamLength = 2.0;
  const beamRadius = 0.008;

  return (
    <group position={hostPosition}>
      {/* ── Two-Axis Gimbal Model: SATELLITE → FSOC MOUNT → PAN → TILT ── */}
      <group position={fsocAperture}>
        {/* Azimuth Axis (PAN) */}
        <group ref={panGroupRef}>
          {/* Elevation Axis (TILT) */}
          <group ref={tiltGroupRef} onClick={(e) => { e.stopPropagation(); onSelect(cameraId); }}>
            {/* Camera Body */}
            <mesh>
              <boxGeometry args={[0.16, 0.1, 0.22]} />
              <meshStandardMaterial color="#5a6666" metalness={0.8} roughness={0.3} />
            </mesh>
            <mesh position={[0, 0, 0.15]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.055, 0.065, 0.1, 20]} />
              <meshStandardMaterial color="#2c3a40" metalness={0.85} roughness={0.22} />
            </mesh>
            {/* Lens aperture disc — faces +Z (local optical axis) */}
            <mesh position={[0, 0, 0.205]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.042, 0.042, 0.012, 20]} />
              <meshBasicMaterial color="#9fd8e8" transparent opacity={0.9} toneMapped={false} />
            </mesh>

            {/* Narrow 4° × 3° Frustum */}
            {showFov && (
              <group>
                <mesh geometry={frustumGeo}>
                  <meshBasicMaterial color="#69b7c9" transparent opacity={0.07} side={THREE.DoubleSide} depthWrite={false} />
                </mesh>
                {corners.map((c, i) => (
                  <Line key={i} points={[[0, 0, 0], c]} color="#7fc4d4" lineWidth={0.7} transparent opacity={0.55} />
                ))}
                <Line points={[...corners, corners[0]]} color="#8fd2e2" lineWidth={0.9} transparent opacity={0.75} />
                <mesh position={[0, 0, length]}>
                  <planeGeometry args={[hx * 2, hy * 2]} />
                  <meshBasicMaterial color="#69b7c9" transparent opacity={0.05} side={THREE.DoubleSide} depthWrite={false} />
                </mesh>
                <Line points={[[0, 0, 0], [0, 0, length * 0.92]]} color="#e08a7a" lineWidth={0.8} transparent opacity={0.65} dashed dashSize={0.08} gapSize={0.06} />
              </group>
            )}

            {/* Optical-axis beam: short, thin, subtle. Child of the tilt
                group so it inherits the exact optical frame — it shows where
                the camera points, never reaches for the beacon. */}
            {linkActive && (
              <group position={[0, 0, 0.22]}>
                <mesh position={[0, 0, beamLength / 2]} rotation={[Math.PI / 2, 0, 0]}>
                  <cylinderGeometry args={[beamRadius, beamRadius, beamLength, 12]} />
                  <meshBasicMaterial
                    color={state === 'LOCKED' ? '#8fe0b4' : state === 'TRACKING' ? '#5ce6d6' : '#ffd9a0'}
                    transparent
                    opacity={state === 'LOCKED' ? 0.35 : 0.22}
                    blending={THREE.AdditiveBlending}
                    toneMapped={false}
                    depthWrite={false}
                  />
                </mesh>
              </group>
            )}
          </group>
        </group>
      </group>

      {showLabels && <ObjLabel text={`${cameraId} · CAMERA`} color="#9fd8e8" offset={0.62} />}

      {/* Spec §32: Debug visualization vectors at FSOC camera aperture
          RED: opticalForward
          GREEN: camera → beacon
          BLUE: camera UP
          When locked, RED and GREEN overlap perfectly. */}
      {showDebugVectors && (
        <group position={fsocAperture}>
          {/* RED: actual optical axis forward */}
          <Line points={[[0, 0, 0], [fwdDir[0] * 1.8, fwdDir[1] * 1.8, fwdDir[2] * 1.8]]} color="#ff4d4d" lineWidth={2.2} />
          {/* GREEN: camera to beacon line of sight */}
          <Line points={[[0, 0, 0], [dirToBeacon[0] * 1.8, dirToBeacon[1] * 1.8, dirToBeacon[2] * 1.8]]} color="#34d399" lineWidth={2.0} />
          {/* BLUE: camera UP */}
          <Line points={[[0, 0, 0], [cameraUp[0] * 1.2, cameraUp[1] * 1.2, cameraUp[2] * 1.2]]} color="#60a5fa" lineWidth={1.5} />
        </group>
      )}

      {/* Spec §7: When beacon is behind the camera, render an unambiguous scene
          indicator so the operator can see the FSOC sensor cannot detect it. */}
      {inFront === false && (
        <group position={beaconLocal}>
          <mesh renderOrder={999}>
            <sphereGeometry args={[0.08, 10, 8]} />
            <meshBasicMaterial color="#e05050" transparent opacity={0.55} depthTest={false} />
          </mesh>
          <Html center distanceFactor={10} style={{ pointerEvents: 'none' }}>
            <div style={{
              fontFamily: 'monospace', fontSize: 8, color: '#ff8080',
              background: 'rgba(40,0,0,0.82)', border: '1px solid #8b3030',
              padding: '1px 5px', whiteSpace: 'nowrap',
            }}>
              ⊗ BEHIND CAMERA
            </div>
          </Html>
        </group>
      )}

      {/* Visualise aperture pos in host frame */}
      <group visible={false} position={fsocAperture} />
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

// ── Beacon mount offset on a target terminal (Three.js world units) ──
// Co-located with the target group origin so the rendered beacon IS the
// simulated beacon position: the 4°×3° FOV centerline, the optical link
// endpoint, and the boresight metric all reference this exact point when
// locked. A raised stalk would park the marker ~12° off-axis at typical
// depths — outside the very frustum meant to contain it. Visibility is
// instead guaranteed by depth-tested-off marker materials (see Beacon).
const BEACON_LOCAL_OFFSET: V3 = [0, 0, 0];

// ── Backend-driven target + beacon (one root group per target ID) ───
// Renders a target owned by the simulation registry at its live telemetry
// position. Each instance owns an independent THREE.Group (resolved by ID,
// never by selection/index), so tracking or moving one target cannot affect
// another. When selected with the translate gizmo, dragging moves THIS
// target only: on release the world position is posted to the backend,
// which re-anchors that target's trajectory origin. Telemetry then reflects
// the move, the beacon follows via its mount offset, and the FSOC camera
// reacts through detection → Kalman → PID. Satellites and cameras are never
// touched here.
function BackendTargetGroup({
  targetId,
  beaconId,
  position,
  accent,
  beaconColor,
  beaconScale,
  targetLabelColor,
  selected,
  gizmoMode,
  showLabels,
  halo,
  onSelect,
  onMoveTarget,
  onOrbitEnabled,
  reportPosition,
}: {
  targetId: string;
  beaconId: string;
  position: V3;
  accent?: string;
  beaconColor: string;
  beaconScale: number;
  targetLabelColor: string;
  selected: boolean;
  gizmoMode: 'translate' | 'rotate' | null;
  showLabels: boolean;
  halo: boolean;
  onSelect: (id: string) => void;
  onMoveTarget: (id: string, world: V3) => void;
  onOrbitEnabled: (enabled: boolean) => void;
  reportPosition: (id: string, p: V3) => void;
}) {
  const groupRef = useRef<THREE.Group>(null!);
  const draggingRef = useRef(false);

  // Telemetry drives the transform — except while the operator drags, when
  // TransformControls owns it. useLayoutEffect avoids a flash at the origin.
  useLayoutEffect(() => {
    const g = groupRef.current;
    if (!g || draggingRef.current) return;
    g.position.set(position[0], position[1], position[2]);
    reportPosition(targetId, [position[0], position[1], position[2]]);
    reportPosition(beaconId, [
      position[0] + BEACON_LOCAL_OFFSET[0],
      position[1] + BEACON_LOCAL_OFFSET[1],
      position[2] + BEACON_LOCAL_OFFSET[2],
    ]);
  }, [position, targetId, beaconId, reportPosition]);

  return (
    <>
      <group
        ref={groupRef}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(targetId);
        }}
      >
        <SatelliteMesh target accent={selected ? '#ffffff' : accent} />
        {/* Beacon is a child of the target group at BEACON_LOCAL_OFFSET —
            same offset used by LocalObject and VirtualFsocRig. */}
        <group position={BEACON_LOCAL_OFFSET} onClick={(e) => { e.stopPropagation(); onSelect(beaconId); }}>
          <Beacon color={beaconColor} scale={beaconScale} />
          {showLabels && <ObjLabel text={`${beaconId} · BEACON`} color="#bfe6ff" offset={0.2} />}
        </group>
        {showLabels && (
          <ObjLabel
            text={`${targetId} · TARGET`}
            offset={0.48}
            color={targetLabelColor}
          />
        )}
        {halo && selected && (
          <mesh>
            <sphereGeometry args={[0.85, 16, 12]} />
            <meshBasicMaterial color="#e8b34a" transparent opacity={0.1} depthWrite={false} />
          </mesh>
        )}
      </group>
      {selected && gizmoMode === 'translate' && (
        <TransformControls
          object={groupRef}
          mode="translate"
          size={0.75}
          onMouseDown={() => {
            draggingRef.current = true;
            onOrbitEnabled(false);
          }}
          onMouseUp={() => {
            const g = groupRef.current;
            if (g) {
              const np: V3 = [g.position.x, g.position.y, g.position.z];
              reportPosition(targetId, np);
              reportPosition(beaconId, [
                np[0] + BEACON_LOCAL_OFFSET[0],
                np[1] + BEACON_LOCAL_OFFSET[1],
                np[2] + BEACON_LOCAL_OFFSET[2],
              ]);
              onMoveTarget(targetId, np);
            }
            draggingRef.current = false;
            onOrbitEnabled(true);
          }}
        />
      )}
    </>
  );
}

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
          <group
            ref={beaconRef}
            position={BEACON_LOCAL_OFFSET}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(def.beaconId);
            }}
          >
            <Beacon color="#ffd9a0" scale={0.85} />
            {showLabels && <ObjLabel text={`${def.beaconLabel} · BEACON`} color="#bfe6ff" offset={0.2} />}
          </group>
        )}
        {selected && (
          <mesh>
            <sphereGeometry args={[0.75, 16, 12]} />
            <meshBasicMaterial color="#e8b34a" transparent opacity={0.14} depthWrite={false} />
          </mesh>
        )}
        {showLabels && <ObjLabel text={`${def.displayLabel} · ${isTarget ? 'TARGET' : 'SATELLITE'}`} color={isTarget ? '#f0c98a' : '#9fd8e8'} />}
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
  resolveWorldPos,
  fallback,
  orbitEnabled,
}: {
  viewReq: ViewRequest | null;
  cameraMode: CameraMode;
  setCameraMode: (mode: CameraMode) => void;
  followId: string | null;
  // Authoritative entity position lookup (telemetry-first, then client
  // reports, then statics). positionsRef alone is insufficient: backend-
  // driven targets/beacons never report into it, so resolving focus/follow
  // from it would silently aim at the live tracked target instead.
  resolveWorldPos: (id: string | null) => V3 | null;
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
  const resolveRef = useRef(resolveWorldPos);
  resolveRef.current = resolveWorldPos;
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
      // FOCUS resolves the SELECTED entity (never the tracked one) through
      // the authoritative resolver. Viewer camera only — FSOC pan/tilt,
      // PID, Kalman and tracking state are untouched by this path.
      const p = (fid && resolveRef.current(fid)) || fb;
      console.debug('[ASTERIA FOCUS START]', {
        entityId: fid, worldPos: p, fellBackToLive: !(fid && resolveRef.current(fid)),
      });
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
    const p = (followId && resolveWorldPos(followId)) || fallback;
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
  onMoveTarget: (id: string, world: V3) => void;
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
  resolveWorldPos: (id: string | null) => V3 | null;
  showDebugVectors?: boolean;
}) {
  const { frame, history, settings, objects, selectedId, gizmoMode } = props;

  const targetPosition: V3 = [
    SAT_A_POSITION[0] + finiteOr(frame?.target?.position?.x, 120, 'target.position.x') * WORLD_SCALE,
    SAT_A_POSITION[1] + finiteOr(frame?.target?.position?.y, 60, 'target.position.y') * WORLD_SCALE,
    SAT_A_POSITION[2] + finiteOr(frame?.target?.position?.z, 350, 'target.position.z') * WORLD_SCALE,
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

  const isVideoSource = (frame?.source ?? 'virtual') === 'video_input';
  const activeSession = frame?.tracking_session ?? null;
  const activeSatelliteId = activeSession?.satelliteId ?? frame?.target.entity?.hostSatelliteId ?? 'SAT-01';
  const activeCameraId = activeSession?.cameraId ?? 'FSOC-CAM-01';
  const activeSatellitePosition = props.positionsRef.current.get(activeSatelliteId) ?? SAT_A_POSITION;

  // VIDEO_INPUT has no 3D scenario coordinates: render the measured video
  // beacon as a back-projected marker (centroid through live pan/tilt).
  const fsocApertureWorld: V3 = [
    activeSatellitePosition[0],
    activeSatellitePosition[1] + 0.22,
    activeSatellitePosition[2],
  ];
  const videoMarker = videoBeaconMarker(frame, fsocApertureWorld);

  // Authoritative tracking target ID from session or primary frame target
  const activeTrackedTargetId = activeSession?.targetId ?? frame?.target?.entity?.id ?? frame?.target?.id ?? 'TARGET-01';

  // Build unified, deduplicated target list. Every target has a stable ID,
  // its own independent position, and its own independent Three.js group.
  interface RenderTargetItem {
    id: string;
    beaconId: string;
    hostSatelliteId: string;
    position: V3;
    beaconPosition: V3;
    isPrimary: boolean;
  }
  const targetMap = new Map<string, RenderTargetItem>();

  // 1. Telemetry targets from backend. Positions are finite-guarded: a
  // single NaN/Infinity would silently unmount that Object3D (Three.js
  // culls NaN matrices), so malformed values fall back instead of
  // propagating. Identity falls back to the raw id, never inferred.
  for (const t of frame?.targets ?? []) {
    const tid = t.entity?.id ?? t.id ?? 'UNKNOWN-TARGET';
    const bid = t.entity?.beaconId ?? t.beacon?.id ?? `BEACON-${tid.split('-').pop()}`;
    const hid = t.entity?.hostSatelliteId ?? 'SAT-01';
    let pos: V3 = [
      SAT_A_POSITION[0] + finiteOr(t.position?.x, 0, `targets[${tid}].x`) * WORLD_SCALE,
      SAT_A_POSITION[1] + finiteOr(t.position?.y, 0, `targets[${tid}].y`) * WORLD_SCALE,
      SAT_A_POSITION[2] + finiteOr(t.position?.z, 350, `targets[${tid}].z`) * WORLD_SCALE,
    ];
    if (tid === activeTrackedTargetId && videoMarker) {
      pos = videoMarker;
    }
    const bPos: V3 = [
      pos[0] + BEACON_LOCAL_OFFSET[0],
      pos[1] + BEACON_LOCAL_OFFSET[1],
      pos[2] + BEACON_LOCAL_OFFSET[2],
    ];
    targetMap.set(tid, {
      id: tid,
      beaconId: bid,
      hostSatelliteId: hid,
      position: pos,
      beaconPosition: bPos,
      isPrimary: tid === activeTrackedTargetId,
    });
  }

  // 2. Local objects added by operator that may not yet be in telemetry
  for (const o of objects) {
    if (o.kind === 'target' && !targetMap.has(o.id)) {
      const curP = props.positionsRef.current.get(o.id) ?? o.base;
      const bPos: V3 = [
        curP[0] + BEACON_LOCAL_OFFSET[0],
        curP[1] + BEACON_LOCAL_OFFSET[1],
        curP[2] + BEACON_LOCAL_OFFSET[2],
      ];
      targetMap.set(o.id, {
        id: o.id,
        beaconId: o.beaconId,
        hostSatelliteId: o.hostId,
        position: curP,
        beaconPosition: bPos,
        isPrimary: o.id === activeTrackedTargetId,
      });
    }
  }

  // 3. Fallback: TARGET-01 is ALWAYS present
  if (!targetMap.has('TARGET-01')) {
    const defP: V3 = [
      SAT_A_POSITION[0] + finiteOr(frame?.target?.position?.x, -8.0, 'fallback.position.x') * WORLD_SCALE,
      SAT_A_POSITION[1] + finiteOr(frame?.target?.position?.y, 2.0, 'fallback.position.y') * WORLD_SCALE,
      SAT_A_POSITION[2] + finiteOr(frame?.target?.position?.z, 350.0, 'fallback.position.z') * WORLD_SCALE,
    ];
    const bPos: V3 = [
      defP[0] + BEACON_LOCAL_OFFSET[0],
      defP[1] + BEACON_LOCAL_OFFSET[1],
      defP[2] + BEACON_LOCAL_OFFSET[2],
    ];
    targetMap.set('TARGET-01', {
      id: 'TARGET-01',
      beaconId: 'BEACON-01',
      hostSatelliteId: 'SAT-01',
      position: defP,
      beaconPosition: bPos,
      isPrimary: activeTrackedTargetId === 'TARGET-01',
    });
  }

  const targetsToRender = Array.from(targetMap.values());
  const primaryTargetEntry = targetsToRender.find((t) => t.isPrimary) ?? targetsToRender[0];
  const activeBeaconPos: V3 = primaryTargetEntry?.beaconPosition ?? [
    SAT_A_POSITION[0],
    SAT_A_POSITION[1],
    SAT_A_POSITION[2] + 350 * WORLD_SCALE,
  ];

  return (
    <>
      <color attach="background" args={[SCENE_BG]} />
      <SceneLights brightness={settings.brightness} />
      <StarField visible={settings.stars} />
      <SunVisual />
      <Moon />
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
        {settings.labels && <ObjLabel text="SAT-01 · SATELLITE" offset={0.66} />}
        {selectedId === 'SAT-01' && (
          <mesh>
            <sphereGeometry args={[0.85, 16, 12]} />
            <meshBasicMaterial color="#e8b34a" transparent opacity={0.1} depthWrite={false} />
          </mesh>
        )}
      </group>

      {/* Unified targets: each has its own THREE.Group, its own Beacon, keyed by permanent ID */}
      {targetsToRender.map((t) => (
        <BackendTargetGroup
          key={t.id}
          targetId={t.id}
          beaconId={t.beaconId}
          position={t.position}
          accent={t.isPrimary ? undefined : '#e0a44a'}
          beaconColor={t.isPrimary ? (state === 'LOCKED' ? '#c4ffd9' : '#bfe0ff') : '#ffd9a0'}
          beaconScale={t.isPrimary ? 1.0 : 0.8}
          targetLabelColor={t.isPrimary ? '#f0e2c4' : '#f0c98a'}
          selected={selectedId === t.id || selectedId === t.beaconId}
          gizmoMode={selectedId === t.id && (!isVideoSource || !t.isPrimary) ? gizmoMode : null}
          showLabels={settings.labels}
          halo={t.isPrimary}
          onSelect={props.onSelect}
          onMoveTarget={props.onMoveTarget}
          onOrbitEnabled={props.onOrbitEnabled}
          reportPosition={reportPosition}
        />
      ))}

      {/* virtual tracking camera + FOV (telemetry-driven) */}
      <VirtualFsocRig
        frame={frame}
        cameraId={activeCameraId}
        hostPosition={activeSatellitePosition}
        targetPosition={primaryTargetEntry.position}
        beaconWorldPos={activeBeaconPos}
        showFov={settings.fov}
        showLabels={settings.labels}
        showDebugVectors={props.showDebugVectors ?? true}
        inFront={(() => {
          // Compute inFront inline for 3D scene indicator — matches trackingSync logic
          const fp = frame;
          if (!fp) return null;
          const p = fp.camera.pan ?? 0;
          const t = fp.camera.tilt ?? 0;
          const D2R = Math.PI / 180;
          const ax = Math.sin(p * D2R) * Math.cos(t * D2R);
          const ay = Math.sin(t * D2R);
          const az = Math.cos(p * D2R) * Math.cos(t * D2R);
          const dx = activeBeaconPos[0] - (activeSatellitePosition[0]);
          const dy = activeBeaconPos[1] - (activeSatellitePosition[1] + 0.22);
          const dz = activeBeaconPos[2] - (activeSatellitePosition[2]);
          const len = Math.hypot(dx, dy, dz);
          if (len < 1e-9) return null;
          return (ax * dx + ay * dy + az * dz) / len > 0;
        })()}
        reportPosition={reportPosition}
        onSelect={props.onSelect}
      />
      <TrajectoryLine history={history} visible={settings.trajectory} />

      {/* user-added non-target visualisation objects (e.g. additional satellites) */}
      {objects.filter((def) => def.kind !== 'target').map((def) => (
        <LocalObject
          key={def.id}
          def={def}
          selected={selectedId === def.id}
          gizmoMode={selectedId === def.id ? gizmoMode : null}
          showLabels={settings.labels}
          showBeacon={false}
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
        resolveWorldPos={props.resolveWorldPos}
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
  const [entityGraph, setEntityGraph] = useState<SimulationEntity[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [gizmoMode, setGizmoMode] = useState<'translate' | 'rotate' | null>('translate');
  const [viewReq, setViewReq] = useState<ViewRequest | null>(null);
  const [cameraMode, setCameraMode] = useState<CameraMode>('free');
  const [orbitEnabled, setOrbitEnabled] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showShift, setShowShift] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [showFsocDebug, setShowFsocDebug] = useState(true);
  const [showSync, setShowSync] = useState(false);
  const [panelTick, setPanelTick] = useState<V3 | null>(null);
  const [offset, setOffset] = useState<V3>([0, 0, 0]);
  const offsetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const positionsRef = useRef<Map<string, V3>>(new Map());
  const velocitiesRef = useRef<Map<string, V3>>(new Map());

  // END DEMO is distinct from STOP TRACKING: discard only client-side
  // runtime scene objects when the backend broadcasts its clean scenario.
  useEffect(() => {
    if (!frame?.scenario_reset) return;
    setObjects([]);
    setSelectedId(null);
    setGizmoMode(null);
    setEntityGraph([]);
    positionsRef.current.clear();
    velocitiesRef.current.clear();
    localTargetCounter = 1;
    localSatCounter = 1;
    void refreshEntityGraph();
  }, [frame?.scenario_reset]);

  // The backend registry is the authoritative identity/relationship graph.
  // The local scene only owns display transforms and operator-only labels.
  const refreshEntityGraph = async () => {
    try {
      const registry = await fsocApi.getEntityRegistry();
      const ids = registry.entities.map((entity) => entity.id);
      if (new Set(ids).size !== ids.length) {
        console.error('[ASTERIA STATE ERROR] duplicate entity ID returned by simulation registry');
        return;
      }
      setEntityGraph(registry.entities);
    } catch (error) {
      console.warn('Unable to refresh ASTERIA entity registry', error);
    }
  };

  useEffect(() => {
    void refreshEntityGraph();
  }, []);

  // IDs are semantic, never inferred from a display name. A target and its
  // mounted beacon are separate selectable entities even when users rename them.
  const liveTargetId = frame?.target?.entity?.id ?? frame?.target?.id ?? 'TARGET-01';
  const liveBeaconId = frame?.target?.entity?.beaconId ?? frame?.target?.beacon?.id ?? 'BEACON-01';
  const activeSession = frame?.tracking_session ?? null;
  const activeSatelliteId = activeSession?.satelliteId ?? frame?.target?.entity?.hostSatelliteId ?? 'SAT-01';
  const activeCameraId = activeSession?.cameraId ?? 'FSOC-CAM-01';
  const liveTargetLabel = liveTargetId;
  const liveBeaconLabel = liveBeaconId;

  // Lifecycle diagnostics (§1/§18/§33): transition-only console trace plus
  // a live snapshot for console inspection via window.__ASTERIA_DEBUG__.
  useEffect(() => {
    console.debug('[DEMO] live target resolved', {
      liveTargetId,
      liveBeaconId,
      hasFrame: frame !== null,
      targetState: frame?.target_state ?? null,
      entityIds: entityGraph.map((e) => e.id),
    });
    (window as unknown as { __ASTERIA_DEBUG__?: unknown }).__ASTERIA_DEBUG__ = {
      selectedId,
      liveTargetId,
      liveBeaconId,
      entityIds: entityGraph.map((e) => e.id),
      targetState: frame?.target_state ?? null,
      hasFrame: frame !== null,
    };
  }, [liveTargetId, liveBeaconId, entityGraph, selectedId]);

  // Authoritative world-position lookup for ANY entity id (targets and
  // beacons, backend-driven or local). Telemetry wins for ids the backend
  // owns — client reports for those go stale once their LocalObject is
  // dedup-filtered out of the tree. Falls back to client reports (local
  // objects, SAT-01, camera aperture) and finally statics. Used by FOCUS,
  // FOLLOW and the inspector so they never silently aim at the live
  // tracked target when another entity is selected.
  const simToWorld = (x: number, y: number, z: number): V3 => ([
    SAT_A_POSITION[0] + x * WORLD_SCALE,
    SAT_A_POSITION[1] + y * WORLD_SCALE,
    SAT_A_POSITION[2] + z * WORLD_SCALE,
  ]);
  const resolveEntityWorldPos = (id: string | null): V3 | null => {
    if (!id) return null;
    const liveTargets = frame?.targets ?? [];
    for (const t of liveTargets) {
      const tid = t.entity?.id ?? t.id;
      if (tid === id && t.position) {
        return simToWorld(t.position.x, t.position.y, t.position.z);
      }
      const bid = t.entity?.beaconId ?? t.beacon?.id;
      if (bid && bid === id && t.position) {
        const w = simToWorld(t.position.x, t.position.y, t.position.z);
        return [w[0] + BEACON_LOCAL_OFFSET[0], w[1] + BEACON_LOCAL_OFFSET[1], w[2] + BEACON_LOCAL_OFFSET[2]];
      }
    }
    const reported = positionsRef.current.get(id);
    if (reported) return reported;
    if (id === 'SAT-01') return SAT_A_POSITION;
    return null;
  };

  const handleSelect = (id: string | null) => {
    console.debug('[ASTERIA SELECTION]', {
      selectedEntityId: id,
      activeTrackingTargetId: activeSession?.targetId ?? liveTargetId,
    });
    setSelectedId(id);
  };

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
        id: `TARGET-${n}`,
        kind: 'target',
        type: 'target',
        label: `TARGET-${n}`,
        displayLabel: `TARGET-${n}`,
        hostId: 'SAT-01',
        beaconId: `BEACON-${n}`,
        beaconLabel: `BEACON-${n}`,
        cameraId: 'FSOC-CAM-01',
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
          satellite_id: def.hostId,
          camera_id: def.cameraId,
          beacon_size_px: 10.0,
          beacon_shape: 'square',
        });
        await refreshEntityGraph();
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
        id: `SAT-${n}`,
        kind: 'satellite',
        type: 'satellite',
        label: `SAT-${n}`,
        displayLabel: `SAT-${n}`,
        hostId: `SAT-${n}`,
        beaconId: cameraId,
        beaconLabel: cameraId,
        cameraId,
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
        await refreshEntityGraph();
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
    if (!selectedId || selectedId === 'SAT-01' || selectedId === 'FSOC-CAM-01' || selectedId === liveTargetId || selectedId === liveBeaconId) return;
    const owner = objects.find((o) => o.id === selectedId || o.beaconId === selectedId);
    if (!owner) return;
    setObjects((p) => p.filter((o) => o.id !== owner.id));
    positionsRef.current.delete(selectedId);
    velocitiesRef.current.delete(selectedId);
    setSelectedId(null);
  };

  const selectedLocal = objects.find((o) => o.id === selectedId) ?? null;
  const selectedLocalBeaconOwner = objects.find((o) => o.beaconId === selectedId) ?? null;
  const selectedGraphEntity = entityGraph.find((entity) => entity.id === selectedId) ?? null;
  // Entity type comes from the backend graph, never from display text or ID format.
  const isLiveTarget = selectedId === liveTargetId && (selectedGraphEntity?.type ?? 'target') === 'target';
  const isLiveBeacon = selectedId === liveBeaconId && (selectedGraphEntity?.type ?? 'beacon') === 'beacon';
  const isLiveSat = selectedId === activeSatelliteId && (selectedGraphEntity?.type ?? 'satellite') === 'satellite';
  const isLiveCamera = selectedId === activeCameraId && (selectedGraphEntity?.type ?? 'fsoc_camera') === 'fsoc_camera';
  const isLiveSelection = isLiveTarget || isLiveBeacon || isLiveSat || isLiveCamera;

  // Resolve the selection to a backend-owned target (directly, or via its
  // beacon's parent link). ID-based, never positional: moving one target
  // must never resolve to another. Drives the inspector, MOVE gizmo and
  // TRACK button for selections the backend owns.
  const inspectedBackendEntry = (() => {
    if (!selectedId) return null;
    for (const t of frame?.targets ?? []) {
      const tid = t.entity?.id ?? t.id;
      const bid = t.entity?.beaconId ?? t.beacon?.id ?? null;
      const host = t.entity?.hostSatelliteId ?? null;
      const pos = t.position ?? null;
      const vel = (t as { velocity?: { x: number; y: number; z: number } }).velocity ?? null;
      if (tid === selectedId) {
        return { targetId: tid, beaconId: bid ?? tid, hostId: host, pos, vel, isBeacon: false };
      }
      if (bid && bid === selectedId) {
        return { targetId: tid, beaconId: bid, hostId: host, pos, vel, isBeacon: true };
      }
    }
    return null;
  })();
  const selectedBackendTargetId = inspectedBackendEntry?.targetId ?? null;
  const inspectedBeaconId =
    isLiveTarget ? liveBeaconLabel
    : selectedLocal?.kind === 'target' ? selectedLocal.beaconLabel
    : inspectedBackendEntry && !inspectedBackendEntry.isBeacon ? inspectedBackendEntry.beaconId
    : inspectedBackendEntry?.isBeacon ? inspectedBackendEntry.beaconId
    : null;

  // Operator manual move of ONE backend-owned target (translate gizmo on its
  // BackendTargetGroup). World → sim metres, then POST; the backend
  // re-anchors only that target's trajectory origin. Beacon follows via its
  // mount offset; satellites, cameras and tracking state are untouched.
  const moveBackendTarget = (id: string, world: V3) => {
    const simPos = {
      x: (world[0] - SAT_A_POSITION[0]) / WORLD_SCALE,
      y: (world[1] - SAT_A_POSITION[1]) / WORLD_SCALE,
      z: (world[2] - SAT_A_POSITION[2]) / WORLD_SCALE,
    };
    console.debug('[ASTERIA TARGET MOVE]', {
      targetId: id,
      simPos,
      trackingTargetId: activeSession?.targetId ?? liveTargetId,
      trackingState: frame?.target_state ?? null,
    });
    void fsocApi.moveTarget(id, simPos).catch((e) => {
      console.error('Failed to move target', e);
    });
  };

  // Track a backend-owned target by ID. The backend resolves the stored
  // target → beacon → satellite → camera relationship and opens a tracking
  // session; no position payload is needed (and ignored) for registered ids.
  // Selection state is deliberately untouched — tracking and selection are
  // independent concepts.
  const trackBackendTarget = async (tid: string) => {
    setSwitching(true);
    try {
      const entry = (frame?.targets ?? []).find((t) => (t.entity?.id ?? t.id) === tid);
      console.debug('[ASTERIA TRACKING START]', {
        targetId: tid,
        beaconId: entry?.entity?.beaconId ?? entry?.beacon?.id ?? null,
        satelliteId: entry?.entity?.hostSatelliteId ?? null,
      });
      await fsocApi.switchTarget({ target_id: tid });
      setObjects((prev) =>
        prev.map((o) =>
          o.kind === 'target'
            ? { ...o, trackingState: o.id === tid ? 'TRACKING' : 'IDLE' }
            : o,
        ),
      );
    } catch (e) {
      console.error('Failed to track target', e);
    } finally {
      setSwitching(false);
    }
  };

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
  // 2D↔3D sync validation (read-only): same pan/tilt the 2D controller
  // outputs, re-projected through the twin's world geometry. Boresight and
  // containment must agree with the sim's own angular error / projection.
  // NOTE: showSync/showFsocDebug live with the other overlay state above
  // (single declaration — do not redeclare here).
  const syncSatId = frame?.tracking_session?.satelliteId
    ?? (frame?.target as unknown as { entity?: { hostSatelliteId?: string } } | undefined)?.entity?.hostSatelliteId
    ?? 'SAT-01';
  const syncSatWorld: V3 = positionsRef.current.get(syncSatId) ?? SAT_A_POSITION;
  // Optical aperture offset in the host frame (matches VirtualFsocRig).
  const syncCamWorld: V3 = [syncSatWorld[0], syncSatWorld[1] + 0.22, syncSatWorld[2]];
  const syncMarker = videoBeaconMarker(frame, syncCamWorld);
  const sync = computeTrackingSync(frame, syncSatWorld, [0, 0.22, 0], SAT_A_POSITION, WORLD_SCALE, syncMarker);
  const trackingOwnsCamera = ['ACQUIRING', 'TRACKING', 'LOCKED', 'REACQUIRING', 'SEARCHING'].includes(tstate);
  const fallbackEntityIds = ['SAT-01', 'FSOC-CAM-01', liveTargetId, liveBeaconId, ...objects.flatMap((o) => o.kind === 'target' ? [o.id, o.beaconId] : [o.id, o.cameraId])];
  const entityListIds = Array.from(new Set(entityGraph.length ? entityGraph.map((entity) => entity.id) : fallbackEntityIds));

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
        camera={{ position: [4.8, 2.8, 7.4], fov: 43, near: 0.01, far: 200 }}
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
          onMoveTarget={moveBackendTarget}
          resolveWorldPos={resolveEntityWorldPos}
          viewReq={viewReq}
          cameraMode={cameraMode}
          setCameraMode={setCameraMode}
          orbitEnabled={orbitEnabled}
          positionsRef={positionsRef}
          velocitiesRef={velocitiesRef}
          onSelect={handleSelect}
          onMove={(id, base) => updateObject(id, { base })}
          onRotate={(id, rot) => updateObject(id, { rotation: rot })}
          onOrbitEnabled={setOrbitEnabled}
          showDebugVectors={showFsocDebug}
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
          {/* ── Spec §21: Comprehensive FSOC Debug Panel ──────────────────── */}
          {sync && (
            <div style={{ ...panel, padding: '3px 8px', fontSize: 9 }}>
              <span style={{ color: '#8fd0c4' }}>
                BORESIGHT {sync.boresightDeg === null ? '—' : `${sync.boresightDeg.toFixed(2)}°`}
              </span>
              <span style={{ color: '#626a6d' }}> · </span>
              <span style={{ color: sync.inFov ? '#8fe0b4' : sync.inFov === false ? '#e08a7a' : '#9fd8e8' }}>
                FOV: {sync.inFov === null ? '—' : sync.inFov ? 'YES ✓' : 'NO'}
              </span>
              <button
                style={{ ...chipBtn, pointerEvents: 'auto', fontSize: 8, padding: '1px 5px', marginLeft: 6, ...(showFsocDebug ? chipOn : {}) }}
                onClick={() => setShowFsocDebug((s) => !s)}
                title="Spec §21: Comprehensive FSOC camera debug panel"
              >
                {showFsocDebug ? '▾ FSOC DBG' : '▸ FSOC DBG'}
              </button>
              <button
                style={{ ...chipBtn, pointerEvents: 'auto', fontSize: 8, padding: '1px 5px', marginLeft: 4 }}
                onClick={() => setShowSync((s) => !s)}
                title="2D tracking ↔ 3D twin consistency debug values (read-only)"
              >
                {showSync ? '▾ SYNC' : '▸ SYNC'}
              </button>
            </div>
          )}
          {/* Spec §21: Full FSOC debug panel */}
          {sync && showFsocDebug && (() => {
            // ── Beacon camera-space XYZ (same inverse gimbal rotation as beaconInFov) ──
            const _bw = sync.beaconWorld;
            const _cw = sync.camWorld;
            const _dbx = _bw[0] - _cw[0];
            const _dby = _bw[1] - _cw[1];
            const _dbz = _bw[2] - _cw[2];
            const _panR = sync.pan * Math.PI / 180;
            const _tiltR = sync.tilt * Math.PI / 180;
            const _cp = Math.cos(_panR); const _sp = Math.sin(_panR);
            const _x1 = _cp * _dbx - _sp * _dbz;
            const _z1 = _sp * _dbx + _cp * _dbz;
            const _ct = Math.cos(_tiltR); const _st = Math.sin(_tiltR);
            const _bcx = _x1;
            const _bcy = _ct * _dby - _st * _z1;
            const _bcz = _st * _dby + _ct * _z1;
            // ── Entity counts from the registry graph ──
            const _numTargets   = entityGraph.filter((e) => e.type === 'target').length   || (frame?.targets?.length ?? 1);
            const _numBeacons   = entityGraph.filter((e) => e.type === 'beacon').length   || (frame?.targets?.length ?? 1);
            const _numSats      = entityGraph.filter((e) => e.type === 'satellite').length || 1;
            const _numCameras   = entityGraph.filter((e) => e.type === 'fsoc_camera').length || 1;
            return (
            <div style={{
              ...panel, padding: '8px 10px', fontSize: 9,
              display: 'flex', flexDirection: 'column', gap: 3,
              borderLeft: '2px solid #4a7a8a', maxWidth: 230,
            }}>
              {/* ── ENTITY COUNTS ── */}
              <div style={{ color: '#7fc4d4', fontWeight: 700, letterSpacing: '0.1em', marginBottom: 2 }}>ENTITY COUNTS</div>
              <FsocDbgRow label="Targets"    value={String(_numTargets)} />
              <FsocDbgRow label="Beacons"    value={String(_numBeacons)} />
              <FsocDbgRow label="Satellites" value={String(_numSats)} />
              <FsocDbgRow label="Cameras"    value={String(_numCameras)} />

              {/* ── SELECTED IDs ── */}
              <div style={{ color: '#8d9195', marginTop: 3, letterSpacing: '0.08em' }}>SELECTED</div>
              <FsocDbgRow label="Target ID"   value={liveTargetId} />
              <FsocDbgRow label="Beacon ID"   value={liveBeaconId} />
              <FsocDbgRow label="Satellite ID" value={activeSatelliteId} />
              <FsocDbgRow label="Camera ID"   value={activeCameraId} />

              {/* ── FSOC CAMERA ── */}
              <div style={{ color: '#7fc4d4', fontWeight: 700, letterSpacing: '0.1em', marginTop: 3 }}>FSOC CAMERA</div>
              <FsocDbgRow label="PAN" value={`${sync.pan.toFixed(3)}°`} />
              <FsocDbgRow label="TILT" value={`${sync.tilt.toFixed(3)}°`} />
              <FsocDbgRow label="FOV" value={`${sync.fovH}° × ${sync.fovV}°`} />

              {/* ── OPTICAL AXIS ── */}
              <div style={{ color: '#8d9195', marginTop: 3, letterSpacing: '0.08em' }}>OPTICAL AXIS</div>
              <FsocDbgRow label="X" value={sync.forward[0].toFixed(4)} />
              <FsocDbgRow label="Y" value={sync.forward[1].toFixed(4)} />
              <FsocDbgRow label="Z" value={sync.forward[2].toFixed(4)} />

              {/* ── BEACON DIRECTION ── */}
              <div style={{ color: '#8d9195', marginTop: 3, letterSpacing: '0.08em' }}>BEACON DIRECTION</div>
              {sync.toBeaconDir ? (
                <>
                  <FsocDbgRow label="X" value={sync.toBeaconDir[0].toFixed(4)} />
                  <FsocDbgRow label="Y" value={sync.toBeaconDir[1].toFixed(4)} />
                  <FsocDbgRow label="Z" value={sync.toBeaconDir[2].toFixed(4)} />
                </>
              ) : <FsocDbgRow label="—" value="—" />}

              {/* ── BEACON WORLD + CAMERA-SPACE POSITION ── */}
              <div style={{ color: '#8d9195', marginTop: 3, letterSpacing: '0.08em' }}>BEACON WORLD</div>
              <FsocDbgRow label="X" value={sync.beaconWorld[0].toFixed(4)} />
              <FsocDbgRow label="Y" value={sync.beaconWorld[1].toFixed(4)} />
              <FsocDbgRow label="Z" value={sync.beaconWorld[2].toFixed(4)} />
              <div style={{ color: '#8d9195', marginTop: 3, letterSpacing: '0.08em' }}>BEACON CAMERA-SPACE</div>
              <FsocDbgRow label="X" value={_bcx.toFixed(4)} />
              <FsocDbgRow label="Y" value={_bcy.toFixed(4)} />
              <FsocDbgRow label="Z" value={_bcz.toFixed(4)} />

              {/* ── ANGULAR ERROR ── */}
              <div style={{ color: '#8d9195', marginTop: 3, letterSpacing: '0.08em' }}>ANGULAR ERROR</div>
              <FsocDbgRow
                label="Horizontal"
                value={sync.angErrHDeg !== null ? `${sync.angErrHDeg.toFixed(3)}°` : '—'}
                highlight={sync.angErrHDeg !== null && Math.abs(sync.angErrHDeg) < 0.5}
              />
              <FsocDbgRow
                label="Vertical"
                value={sync.angErrVDeg !== null ? `${sync.angErrVDeg.toFixed(3)}°` : '—'}
                highlight={sync.angErrVDeg !== null && Math.abs(sync.angErrVDeg) < 0.5}
              />
              <FsocDbgRow
                label="Boresight"
                value={sync.boresightDeg !== null ? `${sync.boresightDeg.toFixed(3)}°` : '—'}
              />

              {/* ── BEACON STATUS ── */}
              <div style={{ color: '#8d9195', marginTop: 3, letterSpacing: '0.08em' }}>BEACON</div>
              <FsocDbgRow
                label="Front"
                value={sync.inFront === null ? '—' : sync.inFront ? 'YES' : 'NO'}
                highlight={sync.inFront === true}
                warn={sync.inFront === false}
              />
              <FsocDbgRow
                label="In FOV"
                value={sync.inFov === null ? '—' : sync.inFov ? 'YES' : 'NO'}
                highlight={sync.inFov === true}
                warn={sync.inFov === false}
              />
              <FsocDbgRow
                label="Detected"
                value={frame?.detection?.detected ? 'YES' : 'NO'}
                highlight={frame?.detection?.detected === true}
                warn={frame?.detection?.detected === false}
              />

              {/* ── IMAGE PLANE ── */}
              <div style={{ color: '#8d9195', marginTop: 3, letterSpacing: '0.08em' }}>IMAGE</div>
              <FsocDbgRow label="Beacon X" value={sync.centroid ? sync.centroid.x.toFixed(2) : '—'} />
              <FsocDbgRow label="Beacon Y" value={sync.centroid ? sync.centroid.y.toFixed(2) : '—'} />
              <FsocDbgRow label="Center X" value="320" />
              <FsocDbgRow label="Center Y" value="240" />

              {/* ── IMAGE-PLANE ERROR ── */}
              <div style={{ color: '#8d9195', marginTop: 3, letterSpacing: '0.08em' }}>ERROR</div>
              <FsocDbgRow
                label="X"
                value={sync.errPx ? `${sync.errPx.x.toFixed(2)} px` : '—'}
                highlight={sync.errPx !== null && Math.abs(sync.errPx.x) < 10}
              />
              <FsocDbgRow
                label="Y"
                value={sync.errPx ? `${sync.errPx.y.toFixed(2)} px` : '—'}
                highlight={sync.errPx !== null && Math.abs(sync.errPx.y) < 10}
              />
              <FsocDbgRow
                label="Radial"
                value={sync.errPx ? `${Math.sqrt(sync.errPx.x ** 2 + sync.errPx.y ** 2).toFixed(2)} px` : '—'}
                highlight={sync.errPx !== null && Math.sqrt(sync.errPx.x ** 2 + sync.errPx.y ** 2) < 10}
              />

              {/* ── OPTICAL BEAM ── */}
              <div style={{ color: '#8d9195', marginTop: 3, letterSpacing: '0.08em' }}>BEAM</div>
              <FsocDbgRow label="Origin" value={sync.camWorld.map((v) => v.toFixed(2)).join(', ')} />
              <FsocDbgRow label="Direction" value={sync.forward.map((v) => v.toFixed(3)).join(', ')} />

              {/* ── STATE ── */}
              <div style={{
                marginTop: 5, padding: '2px 6px', textAlign: 'center', fontWeight: 700,
                letterSpacing: '0.12em', fontSize: 10,
                color: tstate === 'LOCKED' ? '#8fe0b4' : tstate === 'TRACKING' ? '#ffd9a0'
                  : tstate === 'LOST' || tstate === 'ERROR' ? '#e08a7a' : '#9fd8e8',
                background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(120,160,170,0.2)',
              }}>
                {tstate === 'LOST' ? 'TARGET LOST' : tstate}
              </div>
            </div>
            );
          })()}
          
          {sync && showSync && (
            <div style={{ ...panel, padding: '6px 8px', fontSize: 9, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ color: '#8d9195' }}>2D TRACKING</div>
              <div>centroid <b>{sync.centroid ? `${sync.centroid.x.toFixed(1)}, ${sync.centroid.y.toFixed(1)}` : '—'}</b></div>
              <div>img center <b>{sync.imgCenter.x}, {sync.imgCenter.y}</b></div>
              <div>err px <b>{sync.errPx ? `${sync.errPx.x.toFixed(1)}, ${sync.errPx.y.toFixed(1)}` : '—'}</b></div>
              <div>pan <b>{sync.pan.toFixed(2)}°</b> tilt <b>{sync.tilt.toFixed(2)}°</b></div>
              <div>3D proj <b>{sync.projPx ? `${sync.projPx.x.toFixed(1)}, ${sync.projPx.y.toFixed(1)}` : '—'}</b></div>
              <div>Δ vs centroid <b>{sync.projDeltaPx ? `${sync.projDeltaPx.x.toFixed(1)}, ${sync.projDeltaPx.y.toFixed(1)}` : '—'}</b></div>
              <div style={{ color: '#8d9195', marginTop: 2 }}>3D TWIN</div>
              <div>cam <b>{sync.camWorld.map((v) => v.toFixed(2)).join(', ')}</b></div>
              <div>beacon <b>{sync.beaconWorld.map((v) => v.toFixed(2)).join(', ')}</b></div>
              <div>fwd <b>{sync.forward.map((v) => v.toFixed(3)).join(', ')}</b></div>
              <div>toBeacon <b>{sync.toBeaconDir ? sync.toBeaconDir.map((v) => v.toFixed(3)).join(', ') : '—'}</b></div>
              <div>h/v err <b>{sync.angErrHDeg === null || sync.angErrVDeg === null ? '—' : `${sync.angErrHDeg.toFixed(2)}°, ${sync.angErrVDeg.toFixed(2)}°`}</b></div>
              <div>in front <b>{sync.inFront === null ? '—' : sync.inFront ? 'YES' : 'NO'}</b></div>
              <div>boresight <b>{sync.boresightDeg === null ? '—' : `${sync.boresightDeg.toFixed(2)}°`}</b></div>
              <div>fov <b>{sync.fovH}° × {sync.fovV}°</b></div>
              <div>state <b>{sync.state}</b></div>
            </div>
          )}
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
            {entityListIds.map((id) => {
              const obj = objects.find((o) => o.id === id);
              const beaconOwner = objects.find((o) => o.beaconId === id);
              const isSelected = selectedId === id;
              const label = id === 'SAT-01' || id === 'FSOC-CAM-01' ? id : id === liveTargetId ? liveTargetLabel : id === liveBeaconId ? liveBeaconLabel : (beaconOwner?.beaconLabel || obj?.displayLabel || id);
              return (
                <button
                  key={id}
                  style={{ ...chipBtn, pointerEvents: 'auto', ...(isSelected ? chipOn : {}) }}
                  onClick={() => handleSelect(id)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* right: selected-object structured inspector (selection-driven;
            never replaced by the active tracking target) */}
        {(selectedLocal || selectedLocalBeaconOwner || isLiveSelection || selectedBackendTargetId) && (
          <div style={{ ...panel, position: 'absolute', right: 8, top: 96, width: 220, padding: 10, pointerEvents: 'auto', maxHeight: 'calc(100% - 150px)', overflowY: 'auto' }}>
            {/* Header: Name + Tracking State Dot */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #233544', paddingBottom: 6, marginBottom: 6 }}>
              <div style={{ color: '#f0b35a', fontWeight: 600, fontSize: 13 }}>
                {isLiveTarget ? liveTargetLabel : isLiveBeacon ? liveBeaconLabel : isLiveCamera ? 'FSOC-CAM-01' : isLiveSat ? 'SAT-01' : (selectedLocalBeaconOwner?.beaconLabel || selectedLocal?.displayLabel || selectedId)}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
                <span
                  style={{
                    display: 'inline-block',
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    backgroundColor: (isLiveTarget || isLiveBeacon)
                      ? (tstate === 'LOCKED' ? '#8fe0b4' : tstate === 'TRACKING' ? '#ffd9a0' : tstate === 'LOST' ? '#e08a7a' : '#9fd8e8')
                      : isLiveSat
                        ? '#7fc4d4'
                        : selectedLocal?.trackingState === 'TRACKING' ? '#ffd9a0' : selectedLocal?.trackingState === 'LOCKED' ? '#8fe0b4' : '#6f828a',
                  }}
                />
                <span style={{ color: '#8fa9a1', textTransform: 'uppercase' }}>
                  {isLiveTarget || isLiveBeacon ? tstate : isLiveCamera ? 'FSOC CAMERA' : isLiveSat ? 'ONLINE' : (selectedLocal?.trackingState ?? 'IDLE')}
                </span>
              </div>
            </div>

            {/* Entity Hierarchy Section */}
            <div style={{ borderBottom: '1px solid #233544', paddingBottom: 6, marginBottom: 6 }}>
              <PropRow label="TYPE" value={isLiveTarget ? 'TARGET' : isLiveBeacon || selectedLocalBeaconOwner || inspectedBackendEntry?.isBeacon ? 'BEACON' : isLiveCamera ? 'FSOC CAMERA' : isLiveSat ? 'SATELLITE' : (selectedLocal?.kind ?? 'TARGET').toUpperCase()} />
              <PropRow label={isLiveBeacon || selectedLocalBeaconOwner || inspectedBackendEntry?.isBeacon ? 'PARENT TARGET' : 'HOST'} value={isLiveBeacon ? liveTargetLabel : selectedLocalBeaconOwner?.displayLabel ?? (isLiveTarget ? 'SAT-01 / FSOC-CAM-01' : isLiveCamera ? 'SAT-01' : isLiveSat ? 'FSOC-CAM-01' : (inspectedBackendEntry && !inspectedBackendEntry.isBeacon ? (inspectedBackendEntry.hostId ?? selectedGraphEntity?.hostSatelliteId ?? 'SAT-01') : inspectedBackendEntry?.isBeacon ? inspectedBackendEntry.targetId : (selectedLocal?.hostId ?? selectedGraphEntity?.hostSatelliteId ?? 'SAT-01')))} />
              {(isLiveTarget || selectedLocal?.kind === 'target' || (inspectedBackendEntry && !inspectedBackendEntry.isBeacon)) && inspectedBeaconId && (
                <PropRow label="BEACON" value={inspectedBeaconId} />
              )}
              {selectedLocal && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 5, fontSize: 9 }}>
                  <span style={{ color: '#8d9195' }}>NAME</span>
                  <input
                    value={selectedLocal.displayLabel}
                    onChange={(e) => updateObject(selectedLocal.id, { displayLabel: e.target.value || selectedLocal.label })}
                    style={{ minWidth: 0, flex: 1, background: '#101a22', color: '#dfe6e2', border: '1px solid #38515d', fontFamily: 'monospace', fontSize: 9 }}
                  />
                </label>
              )}
              {selectedLocalBeaconOwner && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 5, fontSize: 9 }}>
                  <span style={{ color: '#8d9195' }}>NAME</span>
                  <input
                    value={selectedLocalBeaconOwner.beaconLabel}
                    onChange={(e) => updateObject(selectedLocalBeaconOwner.id, { beaconLabel: e.target.value || selectedLocalBeaconOwner.beaconId })}
                    style={{ minWidth: 0, flex: 1, background: '#101a22', color: '#dfe6e2', border: '1px solid #38515d', fontFamily: 'monospace', fontSize: 9 }}
                  />
                </label>
              )}
            </div>

            {/* Position & Velocity (selection-driven; backend-owned selections
                read live telemetry so they never show stale zeros) */}
            <div style={{ borderBottom: '1px solid #233544', paddingBottom: 6, marginBottom: 6 }}>
              <div style={{ color: '#8d9195', fontSize: 10, marginBottom: 2 }}>POSITION (WORLD)</div>
              {isLiveTarget || isLiveBeacon ? (
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
              ) : inspectedBackendEntry?.pos ? (
                <>
                  <PropRow label="X" value={`${inspectedBackendEntry.pos.x.toFixed(2)} m`} />
                  <PropRow label="Y" value={`${inspectedBackendEntry.pos.y.toFixed(2)} m`} />
                  <PropRow label="Z" value={`${inspectedBackendEntry.pos.z.toFixed(2)} m`} />
                </>
              ) : (
                <>
                  <PropRow label="X" value={`${shownPos ? ((shownPos[0] - SAT_A_POSITION[0]) / WORLD_SCALE).toFixed(2) : '0.00'} m`} />
                  <PropRow label="Y" value={`${shownPos ? ((shownPos[1] - SAT_A_POSITION[1]) / WORLD_SCALE).toFixed(2) : '0.00'} m`} />
                  <PropRow label="Z" value={`${shownPos ? Math.max(50, (shownPos[2] - SAT_A_POSITION[2]) / WORLD_SCALE).toFixed(2) : '350.00'} m`} />
                </>
              )}

              <div style={{ color: '#8d9195', fontSize: 10, marginTop: 4, marginBottom: 2 }}>VELOCITY</div>
              {isLiveTarget || isLiveBeacon ? (
                <>
                  <PropRow label="X" value={`${(frame?.target.velocity.x ?? 0).toFixed(2)} m/s`} />
                  <PropRow label="Y" value={`${(frame?.target.velocity.y ?? 0).toFixed(2)} m/s`} />
                  <PropRow label="Z" value={`${(frame?.target.velocity.z ?? 0).toFixed(2)} m/s`} />
                </>
              ) : isLiveSat ? (
                <PropRow label="STATIC" value="0.00 m/s" />
              ) : inspectedBackendEntry?.vel ? (
                <>
                  <PropRow label="X" value={`${inspectedBackendEntry.vel.x.toFixed(2)} m/s`} />
                  <PropRow label="Y" value={`${inspectedBackendEntry.vel.y.toFixed(2)} m/s`} />
                  <PropRow label="Z" value={`${inspectedBackendEntry.vel.z.toFixed(2)} m/s`} />
                </>
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

            {isLiveTarget && (
              <div style={{ borderBottom: '1px solid #233544', paddingBottom: 6, marginBottom: 6 }}>
                <PropRow label="MOTION" value={((backendTraj as string) || 'LIVE TRAJECTORY').toUpperCase()} />
                <PropRow label="TRACKING" value={tstate} />
              </div>
            )}

            {(isLiveSat || isLiveCamera) && (
              <div style={{ borderBottom: '1px solid #233544', paddingBottom: 6, marginBottom: 6 }}>
                <PropRow label="PAN" value={`${pan.toFixed(3)}°`} />
                <PropRow label="TILT" value={`${tilt.toFixed(3)}°`} />
                <PropRow label="FOV" value={frame ? `${frame.camera.fov_h}°×${frame.camera.fov_v}°` : '4°×3°'} />
                {/* Optical axis derived from live pan/tilt (§4 authoritative frame) */}
                {sync && (
                  <>
                    <PropRow label="AXIS X" value={sync.forward[0].toFixed(4)} />
                    <PropRow label="AXIS Y" value={sync.forward[1].toFixed(4)} />
                    <PropRow label="AXIS Z" value={sync.forward[2].toFixed(4)} />
                  </>
                )}
                {isLiveCamera && (
                  <div style={{ marginTop: 6, opacity: trackingOwnsCamera ? 0.5 : 1 }}>
                    <div style={{ color: trackingOwnsCamera ? '#d9b06a' : '#8d9195', fontSize: 9, marginBottom: 3 }}>
                      {trackingOwnsCamera ? 'PID OWNS PAN / TILT' : 'MANUAL PAN / TILT'}
                    </div>
                    {(['PAN', 'TILT'] as const).map((axis) => (
                      <label key={axis} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9 }}>
                        <span style={{ width: 25, color: '#8d9195' }}>{axis}</span>
                        <input
                          type="range"
                          min={-45}
                          max={45}
                          step={0.1}
                          value={axis === 'PAN' ? pan : tilt}
                          disabled={trackingOwnsCamera}
                          onChange={(e) => fsocApi.updateCamera(axis === 'PAN' ? Number(e.target.value) : pan, axis === 'TILT' ? Number(e.target.value) : tilt).catch(console.error)}
                          style={{ flex: 1 }}
                        />
                      </label>
                    ))}
                    {/* ── Spec §14: Gimbal Sign Diagnostic ─────────────────── */}
                    <div style={{ marginTop: 8, borderTop: '1px solid #1e2f3a', paddingTop: 5 }}>
                      <div style={{ color: '#d9b06a', fontSize: 9, marginBottom: 3, letterSpacing: '0.08em' }}>⚙ GIMBAL DIAG (§14)</div>
                      <div style={{ fontSize: 8, color: '#6a8090', marginBottom: 4 }}>
                        +PAN → axis X↑ &nbsp; +TILT → axis Y↑
                      </div>
                      <div style={{ display: 'flex', gap: 3 }}>
                        <button
                          style={{ ...chipBtn, flex: 1, fontSize: 8, padding: '2px 4px' }}
                          onClick={() => {
                            const newPan = Math.min(45, pan + 5);
                            fsocApi.updateCamera(newPan, tilt).catch(console.error);
                          }}
                          title="Spec §14 Test 1: +PAN 5° — optical axis X should increase"
                        >
                          +PAN 5°
                        </button>
                        <button
                          style={{ ...chipBtn, flex: 1, fontSize: 8, padding: '2px 4px' }}
                          onClick={() => {
                            const newTilt = Math.min(45, tilt + 5);
                            fsocApi.updateCamera(pan, newTilt).catch(console.error);
                          }}
                          title="Spec §14 Test 2: +TILT 5° — optical axis Y should increase"
                        >
                          +TILT 5°
                        </button>
                        <button
                          style={{ ...chipBtn, fontSize: 8, padding: '2px 4px', color: '#c98a7a' }}
                          onClick={() => fsocApi.updateCamera(0, 0).catch(console.error)}
                          title="Reset gimbal to pan=0, tilt=0"
                        >
                          ↺ 0°
                        </button>
                      </div>
                      {sync && (
                        <div style={{ marginTop: 4, fontSize: 8, color: '#7a9aaa' }}>
                          axis: [{sync.forward.map(v => v.toFixed(3)).join(', ')}]
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Action Buttons: TRACK TARGET & FOCUS TARGET */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
              {selectedBackendTargetId && !inspectedBackendEntry?.isBeacon && (
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
                  onClick={() => void trackBackendTarget(selectedBackendTargetId)}
                  title={`Track ${selectedBackendTargetId} (resolves beacon → satellite → camera)`}
                >
                  {switching ? 'SWITCHING…' : '🎯 TRACK TARGET'}
                </button>
              )}
              {selectedLocal && selectedLocal.kind === 'target' && !selectedBackendTargetId && (
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

                      console.debug('[ASTERIA TRACKING START]', {
                        targetId: selectedLocal.id,
                        beaconId: selectedLocal.beaconId,
                        satelliteId: selectedLocal.hostId,
                        cameraId: selectedLocal.cameraId,
                      });
                      await fsocApi.switchTarget({
                        // Track by immutable entity ID; displayLabel may be renamed by the operator.
                        target_id: selectedLocal.id,
                        position: { x: simX, y: simY, z: simZ },
                        velocity: { x: simVx, y: simVy, z: 0 },
                        trajectory,
                        beacon_offset: { x: 0, y: 0, z: 0 },
                        satellite_id: selectedLocal.hostId,
                        camera_id: selectedLocal.cameraId,
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

              {isLiveTarget && (
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
                  <button
                    style={{
                      ...chipBtn,
                      pointerEvents: 'auto',
                      backgroundColor: '#25180f',
                      borderColor: '#9b6b36',
                      color: '#e8c08b',
                      fontSize: 10,
                      textAlign: 'center',
                      padding: '5px 8px',
                    }}
                    onClick={async () => {
                      try {
                        await fsocApi.endDemo();
                        setObjects([]);
                        setSelectedId(null);
                        localTargetCounter = 1;
                        localSatCounter = 1;
                      } catch (error) {
                        console.error('Failed to end demo', error);
                      }
                    }}
                    title="End the demo and clear runtime-created entities"
                  >
                    ◼ END DEMO
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
                  if (isLiveSat || isLiveCamera) {
                    requestView('camera');
                  } else {
                    requestView('target');
                  }
                }}
              >
                🔍 {isLiveSat || isLiveCamera ? 'FOCUS TERMINAL' : 'FOCUS TARGET'}
              </button>

              {/* Collapsible fine-tuning: 3D shift for live beacon, gizmo for local */}
              {isLiveTarget && (
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

              {selectedBackendTargetId && (
                <div style={{ display: 'flex', gap: 3, marginTop: 4 }}>
                  <button
                    style={{ ...chipBtn, flex: 1, padding: '3px 2px', fontSize: 9, pointerEvents: 'auto', ...(gizmoMode === 'translate' ? chipOn : {}) }}
                    onClick={() => setGizmoMode((m) => (m === 'translate' ? null : 'translate'))}
                    title={`Move ${selectedBackendTargetId} (simulation position)`}
                  >
                    ✥ MOVE
                  </button>
                </div>
              )}
              {selectedLocal && !selectedBackendTargetId && (
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

/** Spec §21: FSOC debug panel row with optional highlight/warn colours. */
function FsocDbgRow({
  label, value, highlight = false, warn = false,
}: { label: string; value: string; highlight?: boolean; warn?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
      <span style={{ color: '#6a8090', minWidth: 70 }}>{label}</span>
      <span style={{
        color: warn ? '#e08a7a' : highlight ? '#8fe0b4' : '#c8d8d4',
        textAlign: 'right', fontWeight: highlight || warn ? 600 : 400,
      }}>{value}</span>
    </div>
  );
}

export function SimulationViewport({ frame, history }: Props) {
  return <Scene3D frame={frame} history={history} />;
}
