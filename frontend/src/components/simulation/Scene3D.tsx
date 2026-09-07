/**
 * FSOC — Engineering 3-D Scene
 *
 * This file intentionally keeps the existing telemetry contract intact while
 * upgrading the presentation layer into a restrained aerospace digital twin.
 */
import React, { useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Line, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { TelemetryFrame } from '../../types/fsoc';

const WORLD_SCALE = 0.008;
const SAT_A_POSITION: [number, number, number] = [0.15, 0.1, 0.15];
const EARTH_POSITION: [number, number, number] = [-2.55, -0.7, -2.15];
const EARTH_RADIUS = 1.55;

function makeEarthTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const ocean = ctx.createLinearGradient(0, 0, 0, canvas.height);
  ocean.addColorStop(0, '#0b2536');
  ocean.addColorStop(0.45, '#0e3c52');
  ocean.addColorStop(1, '#061d2e');
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Low-contrast land masses. The texture is deliberately subdued so it
  // reads as a planet surface rather than a decorative map.
  const land = '#56715e';
  const landDark = '#3d594b';
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
    ctx.globalAlpha = 0.72;
    ctx.fill();
  });

  // Subtle polar ice caps and latitude shading.
  ctx.globalAlpha = 0.2;
  ctx.fillStyle = '#d4e0d7';
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
  canvas.width = 2048;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < 100; i += 1) {
    const x = (i * 197.3) % canvas.width;
    const y = 170 + ((i * 83.7) % 660);
    const width = 50 + ((i * 31) % 180);
    const height = 5 + ((i * 17) % 24);
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, width);
    gradient.addColorStop(0, 'rgba(238,246,242,0.32)');
    gradient.addColorStop(1, 'rgba(238,246,242,0)');
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

function Earth() {
  const surface = useMemo(() => makeEarthTexture(), []);
  const clouds = useMemo(() => makeCloudTexture(), []);
  const cloudRef = useRef<THREE.Mesh>(null!);

  useFrame((_, dt) => {
    if (cloudRef.current) cloudRef.current.rotation.y += dt * 0.018;
  });

  return (
    <group position={EARTH_POSITION}>
      <mesh>
        <sphereGeometry args={[EARTH_RADIUS, 96, 64]} />
        <meshStandardMaterial
          map={surface ?? undefined}
          color="#6d8b88"
          roughness={0.78}
          metalness={0.02}
        />
      </mesh>
      <mesh ref={cloudRef} scale={1.012}>
        <sphereGeometry args={[EARTH_RADIUS, 96, 64]} />
        <meshStandardMaterial
          map={clouds ?? undefined}
          transparent
          opacity={0.33}
          depthWrite={false}
          roughness={1}
        />
      </mesh>
      <mesh scale={1.055}>
        <sphereGeometry args={[EARTH_RADIUS, 64, 48]} />
        <meshBasicMaterial
          color="#74b7c0"
          transparent
          opacity={0.11}
          side={THREE.BackSide}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      <mesh position={[0, 0, EARTH_RADIUS * 0.99]} rotation={[0, 0, 0]}>
        <sphereGeometry args={[0.015, 12, 8]} />
        <meshBasicMaterial color="#d6efe8" transparent opacity={0.8} />
      </mesh>
    </group>
  );
}

function StarField() {
  const points = useMemo(() => {
    const values: number[] = [];
    for (let i = 0; i < 420; i += 1) {
      const phi = Math.acos(1 - 2 * ((i + 0.5) / 420));
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const radius = 22 + (i % 7) * 1.5;
      values.push(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.sin(theta),
      );
    }
    return new Float32Array(values);
  }, []);

  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[points, 3]} />
      </bufferGeometry>
      <pointsMaterial color="#c9d6d4" size={0.035} sizeAttenuation transparent opacity={0.65} />
    </points>
  );
}

function SolarPanel({ side }: { side: -1 | 1 }) {
  return (
    <group position={[side * 0.58, 0, 0]}>
      <mesh>
        <boxGeometry args={[0.82, 0.025, 0.34]} />
        <meshStandardMaterial color="#18364e" emissive="#06131e" emissiveIntensity={0.65} metalness={0.55} roughness={0.32} />
      </mesh>
      <mesh position={[0, 0.016, 0]}>
        <boxGeometry args={[0.78, 0.008, 0.30]} />
        <meshStandardMaterial color="#2c6280" metalness={0.35} roughness={0.3} />
      </mesh>
      {[-0.22, 0, 0.22].map((z) => (
        <mesh key={z} position={[0, 0.022, z]}>
          <boxGeometry args={[0.78, 0.006, 0.008]} />
          <meshBasicMaterial color="#7aa7b9" transparent opacity={0.55} />
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
        <meshStandardMaterial color="#a9ada5" metalness={0.8} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0, -0.08]}>
        <sphereGeometry args={[0.035, 12, 8]} />
        <meshStandardMaterial color="#c6b67f" metalness={0.7} roughness={0.3} />
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
        <meshStandardMaterial color="#5c6664" metalness={0.82} roughness={0.28} />
      </mesh>
      <mesh position={[0, 0.08, 0]}>
        <boxGeometry args={[0.22, 0.08, 0.16]} />
        <meshStandardMaterial color="#303a3b" metalness={0.75} roughness={0.34} />
      </mesh>
      <group ref={panRef}>
        <mesh position={[0.12, 0.08, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.035, 0.035, 0.13, 14]} />
          <meshStandardMaterial color="#b8a16c" metalness={0.78} roughness={0.28} />
        </mesh>
        <group ref={tiltRef}>
          <mesh position={[0, 0.08, 0]} rotation={[0, Math.PI / 2, 0]}>
            <cylinderGeometry args={[0.075, 0.09, 0.28, 24]} />
            <meshStandardMaterial color="#455252" metalness={0.88} roughness={0.25} />
          </mesh>
          <mesh position={[0, 0.08, -0.16]} rotation={[0, Math.PI / 2, 0]}>
            <cylinderGeometry args={[0.042, 0.056, 0.025, 24]} />
            <meshStandardMaterial color={active ? '#8ed6c2' : '#4d7778'} emissive={active ? '#1b6f69' : '#0a2326'} emissiveIntensity={active ? 1.7 : 0.6} metalness={0.3} roughness={0.18} />
          </mesh>
          <mesh position={[0, 0.08, 0.045]} rotation={[0, Math.PI / 2, 0]}>
            <torusGeometry args={[0.084, 0.012, 8, 28]} />
            <meshStandardMaterial color="#b19a68" metalness={0.75} roughness={0.31} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

function Satellite({ position, target, pan, tilt, active, name }: { position: [number, number, number]; target?: boolean; pan?: number; tilt?: number; active?: boolean; name: string }) {
  return (
    <group position={position}>
      <mesh>
        <boxGeometry args={[0.34, 0.22, 0.26]} />
        <meshStandardMaterial color={target ? '#495254' : '#313a3b'} metalness={0.82} roughness={0.31} />
      </mesh>
      <mesh position={[0, 0.02, 0.145]}>
        <boxGeometry args={[0.20, 0.13, 0.012]} />
        <meshStandardMaterial color="#8c8c7b" metalness={0.48} roughness={0.4} />
      </mesh>
      <SolarPanel side={-1} />
      <SolarPanel side={1} />
      <mesh position={[0, -0.15, 0]}>
        <boxGeometry args={[0.25, 0.025, 0.17]} />
        <meshStandardMaterial color="#8e704e" metalness={0.55} roughness={0.44} />
      </mesh>
      <mesh position={[0.19, 0.01, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.025, 0.025, 0.18, 10]} />
        <meshStandardMaterial color="#b8b8aa" metalness={0.9} roughness={0.24} />
      </mesh>
      <Antenna position={[0.04, 0.15, 0.04]} />
      <Antenna position={[-0.09, -0.02, -0.16]} rotation={[Math.PI / 2, 0, 0]} />
      {!target && <GimbalTerminal pan={pan ?? 0} tilt={tilt ?? 0} active={active ?? false} />}
      <Line points={[[0, 0, 0], [0, 0.36, 0]]} color="#8caaa5" lineWidth={0.45} transparent opacity={0.45} />
      <mesh position={[0, 0.38, 0]}>
        <sphereGeometry args={[0.012, 8, 8]} />
        <meshBasicMaterial color="#d3e7de" transparent opacity={0.7} />
      </mesh>
      <mesh position={[0, 0, 0.145]}>
        <boxGeometry args={[0.09, 0.045, 0.008]} />
        <meshBasicMaterial color={target ? '#d1ac6b' : '#73c8bd'} transparent opacity={0.8} />
      </mesh>
      <group scale={0.001} position={[0, 0.52, 0]}>
        <mesh>
          <boxGeometry args={[1, 0.1, 0.02]} />
          <meshBasicMaterial color="#d7e4df" />
        </mesh>
      </group>
      {name && null}
    </group>
  );
}

function TrackingGeometry({ frame, targetPosition }: { frame: TelemetryFrame | null; targetPosition: [number, number, number] }) {
  const pan = frame?.camera.pan ?? 0;
  const tilt = frame?.camera.tilt ?? 0;
  const fovH = frame?.camera.fov_h ?? 28;
  const fovV = frame?.camera.fov_v ?? 21;
  const state = frame?.target_state ?? 'READY';
  const linkActive = state === 'ACQUIRING' || state === 'TRACKING' || state === 'LOCKED' || state === 'REACQUIRING';
  const halfH = THREE.MathUtils.degToRad(fovH / 2);
  const halfV = THREE.MathUtils.degToRad(fovV / 2);
  const length = 2.6;
  const corners: [number, number, number][] = [
    [Math.tan(halfH) * length, Math.tan(halfV) * length, -length],
    [-Math.tan(halfH) * length, Math.tan(halfV) * length, -length],
    [-Math.tan(halfH) * length, -Math.tan(halfV) * length, -length],
    [Math.tan(halfH) * length, -Math.tan(halfV) * length, -length],
  ];
  const panR = THREE.MathUtils.degToRad(pan);
  const tiltR = THREE.MathUtils.degToRad(tilt);
  const direction = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(tiltR, panR, 0, 'XYZ')).normalize();
  const boresightEnd: [number, number, number] = [
    SAT_A_POSITION[0] + direction.x * 2.4,
    SAT_A_POSITION[1] + direction.y * 2.4,
    SAT_A_POSITION[2] + direction.z * 2.4,
  ];

  return (
    <group position={SAT_A_POSITION}>
      <group rotation={[tiltR, panR, 0]}>
        {corners.map((corner, i) => <Line key={i} points={[[0, 0.22, 0], corner]} color="#79a8a4" lineWidth={0.35} opacity={0.17} transparent />)}
        <Line points={[...corners, corners[0]]} color="#79a8a4" lineWidth={0.45} opacity={0.3} transparent />
      </group>
      <Line points={[[0, 0.22, 0], boresightEnd.map((v, i) => v - SAT_A_POSITION[i]) as [number, number, number]]} color="#bb6b62" lineWidth={0.6} opacity={0.5} transparent dashed dashSize={0.08} gapSize={0.07} />
      <Line points={[[0, 0, 0], [targetPosition[0] - SAT_A_POSITION[0], targetPosition[1] - SAT_A_POSITION[1], targetPosition[2] - SAT_A_POSITION[2]]]} color="#77b790" lineWidth={0.45} opacity={0.42} transparent dashed dashSize={0.05} gapSize={0.05} />
      {linkActive && (
        <Line points={[[0, 0.22, 0], [targetPosition[0] - SAT_A_POSITION[0], targetPosition[1] - SAT_A_POSITION[1], targetPosition[2] - SAT_A_POSITION[2]]]} color={state === 'LOCKED' ? '#91d6ba' : '#d0a965'} lineWidth={state === 'LOCKED' ? 0.8 : 0.42} opacity={state === 'LOCKED' ? 0.72 : 0.35} transparent />
      )}
    </group>
  );
}

function TrajectoryLine({ history }: { history: TelemetryFrame[] }) {
  const points = useMemo(() => history.slice(-100).map((f) => [
    SAT_A_POSITION[0] + f.target.position.x * WORLD_SCALE,
    SAT_A_POSITION[1] + f.target.position.y * WORLD_SCALE,
    SAT_A_POSITION[2] + f.target.position.z * WORLD_SCALE,
  ] as [number, number, number]), [history]);
  if (points.length < 2) return null;
  return <Line points={points} color="#91a9a1" lineWidth={0.42} opacity={0.38} transparent dashed dashSize={0.08} gapSize={0.08} />;
}

interface Props {
  frame: TelemetryFrame | null;
  history: TelemetryFrame[];
}

export default function Scene3D({ frame, history }: Props) {
  const targetPosition: [number, number, number] = [
    SAT_A_POSITION[0] + (frame?.target.position.x ?? 120) * WORLD_SCALE,
    SAT_A_POSITION[1] + (frame?.target.position.y ?? 60) * WORLD_SCALE,
    SAT_A_POSITION[2] + (frame?.target.position.z ?? 350) * WORLD_SCALE,
  ];
  const state = frame?.target_state ?? 'READY';
  const active = state !== 'READY' && state !== 'SEARCHING' && state !== 'LOST';

  return (
    <Canvas
      camera={{ position: [4.8, 2.8, 7.4], fov: 43, near: 0.01, far: 100 }}
      gl={{ antialias: true, alpha: false, logarithmicDepthBuffer: true }}
      dpr={[1, 2]}
      style={{ background: '#05090b', width: '100%', height: '100%' }}
    >
      <color attach="background" args={['#05090b']} />
      <fog attach="fog" args={['#05090b', 11, 34]} />
      <ambientLight intensity={0.11} color="#b2c8c5" />
      <directionalLight position={[-5, 3, 4]} intensity={2.3} color="#fff5db" castShadow />
      <directionalLight position={[4, -2, -4]} intensity={0.18} color="#5e8294" />
      <StarField />
      <Earth />
      <Satellite position={SAT_A_POSITION} pan={frame?.camera.pan} tilt={frame?.camera.tilt} active={active} name="SAT-A" />
      <Satellite position={targetPosition} target name="SAT-B" />
      <TrackingGeometry frame={frame} targetPosition={targetPosition} />
      <TrajectoryLine history={history} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.075} minDistance={3.2} maxDistance={22} target={[0, 0, -0.55]} />
    </Canvas>
  );
}

export function SimulationViewport({ frame, history }: Props) {
  return <Scene3D frame={frame} history={history} />;
}
