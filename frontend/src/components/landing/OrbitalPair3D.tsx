/**
 * ASTERIA landing hero — live 3D binary orbital visualization.
 * Two FSOC satellites on crossed, tilted elliptical orbits with a
 * bidirectional optical link that is re-aimed every frame between the
 * terminals' CURRENT world positions. Pure geometry + lighting, no assets.
 *
 * Self-contained: all animation lives in ONE useFrame driver, zero React
 * state updates per frame. Rendered inside the existing .lp-diagram layer
 * (absolute, behind the hero copy, pointer-transparent).
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const AMBER = '#e8a33d';
const AMBER_HOT = '#ffd9a0';

/* Deterministic PRNG so the star field is stable across mounts. */
function mulberry(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ellipsePoints(a: number, b: number, n = 160): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push(new THREE.Vector3(a * Math.cos(t), b * Math.sin(t), 0));
  }
  return pts;
}

function OrbitRing({ a, b, rotation, opacity = 0.55, ticks = false }: {
  a: number; b: number; rotation: [number, number, number]; opacity?: number; ticks?: boolean;
}) {
  const line = useRef<THREE.LineLoop>(null);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry().setFromPoints(ellipsePoints(a, b, 120));
    return g;
  }, [a, b]);
  useLayoutEffect(() => {
    line.current?.computeLineDistances();
  }, [geo]);
  
  // Pixelated dash pattern - using on/off segments like the text
  const dashPattern = useMemo(() => {
    // Creates a pixelated/dotted effect: 2 units on, 3 units off
    return [0.08, 0.12];
  }, []);
  
  return (
    <group rotation={rotation}>
      <lineLoop ref={line} geometry={geo}>
        <lineDashedMaterial 
          color={AMBER} 
          dashSize={dashPattern[0]} 
          gapSize={dashPattern[1]} 
          transparent 
          opacity={opacity} 
        />
      </lineLoop>
    </group>
  );
}

/* Line-art-inspired spacecraft: bus, panel wings, dish, gimballed terminal.
   Nose (terminal) faces local +Z; the driver lookAt()s the partner craft. */
function Satellite({ scale = 1, wing = 1.05, dishSide = 1, termRef }: {
  scale?: number; wing?: number; dishSide?: 1 | -1; termRef: React.RefObject<THREE.Object3D | null>;
}) {
  const busMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#c8b8a0', metalness: 0.6, roughness: 0.25 }),
    [],
  );
  const brightMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#f5e6c8', metalness: 0.4, roughness: 0.3, emissive: '#3a3020', emissiveIntensity: 0.4 }),
    [],
  );
  const darkMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#2d2d44', metalness: 0.5, roughness: 0.4 }),
    [],
  );
  const solarMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#1a2a3a', metalness: 0.8, roughness: 0.15, emissive: '#2a4a6f', emissiveIntensity: 0.5 }),
    [],
  );
  const solarCellMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#005a9e', metalness: 0.7, roughness: 0.2, emissive: '#003a6b', emissiveIntensity: 0.3 }),
    [],
  );
  const goldMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#e8c84a', metalness: 1.0, roughness: 0.05, emissive: '#4a3a10', emissiveIntensity: 0.5 }),
    [],
  );
  const whiteMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#f0f0f0', metalness: 0.1, roughness: 0.7, emissive: '#404040', emissiveIntensity: 0.2 }),
    [],
  );
  const antennaMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#6a6a6a', metalness: 0.8, roughness: 0.2 }),
    [],
  );
  const glowMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: AMBER_HOT }),
    [],
  );
  const ringMat = useMemo(
    () => new THREE.MeshStandardMaterial({
      color: '#4a3a10', metalness: 0.8, roughness: 0.2,
      emissive: new THREE.Color(AMBER), emissiveIntensity: 1.2,
    }),
    [],
  );

  return (
    <group scale={scale}>
      {/* Main bus - hexagonal prism shape */}
      <group>
        <mesh material={brightMat} position={[0, 0, 0]}>
          <cylinderGeometry args={[0.35, 0.35, 0.6, 6]} />
        </mesh>
        {/* Top deck */}
        <mesh material={darkMat} position={[0, 0, 0.35]}>
          <cylinderGeometry args={[0.3, 0.3, 0.05, 6]} />
        </mesh>
        {/* Bottom deck */}
        <mesh material={darkMat} position={[0, 0, -0.35]}>
          <cylinderGeometry args={[0.3, 0.3, 0.05, 6]} />
        </mesh>
        {/* Radiator panels on sides */}
        {([-1, 1] as const).map((s) => (
          <mesh key={s} material={whiteMat} position={[s * 0.38, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
            <boxGeometry args={[0.02, 0.5, 0.55]} />
          </mesh>
        ))}
        {/* MLI blankets - gold foil */}
        <mesh material={goldMat} position={[0, 0, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.36, 0.36, 0.58, 6, 1, true]} />
        </mesh>
      </group>

      {/* Solar array wings on deployable booms */}
      {([-1, 1] as const).map((s) => (
        <group key={s} position={[s * 0.45, 0, 0]}>
          {/* Boom */}
          <mesh material={antennaMat} position={[s * 0.25, 0, 0]}>
            <boxGeometry args={[0.5, 0.04, 0.04]} />
          </mesh>
          <mesh material={antennaMat} position={[s * (0.45 + wing / 2), 0, 0]}>
            <boxGeometry args={[wing, 0.03, 0.03]} />
          </mesh>
          {/* Solar panels - 3 segments each */}
          {[0, 1, 2].map((seg) => (
            <group key={seg} position={[s * (0.45 + 0.15 + seg * wing / 3), 0, 0]}>
              <mesh material={solarMat} position={[0, 0.002, 0]}>
                <boxGeometry args={[wing / 3 - 0.02, 0.04, 0.9]} />
              </mesh>
              {/* Solar cells */}
              {[-1, 1].map((row) => (
                <mesh key={row} material={solarCellMat} position={[0, 0.025, row * 0.28]}>
                  <boxGeometry args={[wing / 3 - 0.06, 0.02, 0.2]} />
                </mesh>
              ))}
            </group>
          ))}
        </group>
      ))}

      {/* High-gain antenna on articulated mast */}
      <group position={[-0.15 * dishSide, 0.35, -0.05]}>
        {/* Mast */}
        <mesh material={antennaMat} position={[0, 0.15, 0]}>
          <cylinderGeometry args={[0.025, 0.025, 0.3, 8]} />
        </mesh>
        {/* Dish reflector */}
        <mesh material={goldMat} position={[0, 0.32, 0.08]} rotation={[0.8, 0, 0]}>
          <coneGeometry args={[0.18, 0.12, 24, 1, true]} />
        </mesh>
        {/* Feed horn */}
        <mesh material={darkMat} position={[0, 0.32, 0.15]}>
          <cylinderGeometry args={[0.035, 0.02, 0.06, 8]} />
        </mesh>
        {/* Feed glow */}
        <mesh material={glowMat} position={[0, 0.32, 0.18]}>
          <sphereGeometry args={[0.02, 8, 8]} />
        </mesh>
      </group>

      {/* Star trackers / optical navigation cameras */}
      {([-1, 1] as const).map((s) => (
        <mesh key={s} material={darkMat} position={[s * 0.2, 0.2, 0.3]}>
          <cylinderGeometry args={[0.04, 0.04, 0.08, 8]} />
        </mesh>
      ))}

      {/* Gimballed optical terminal (beam anchor lives at its snout) */}
      <group>
        <mesh material={darkMat} position={[0, 0, 0.4]}>
          <cylinderGeometry args={[0.08, 0.1, 0.25, 16]} />
        </mesh>
        <mesh material={ringMat} position={[0, 0, 0.55]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.09, 0.02, 12, 32]} />
        </mesh>
        <mesh material={glowMat} position={[0, 0, 0.56]}>
          <sphereGeometry args={[0.035, 16, 16]} />
        </mesh>
        <object3D ref={termRef} position={[0, 0, 0.62]} />
      </group>

      {/* Thruster clusters */}
      {[-1, 1].map((x) => (
        <group key={x}>
          <mesh material={darkMat} position={[x * 0.2, -0.18, -0.4]}>
            <cylinderGeometry args={[0.05, 0.07, 0.12, 8]} />
          </mesh>
          <mesh material={darkMat} position={[x * 0.2, 0.1, -0.4]}>
            <cylinderGeometry args={[0.05, 0.07, 0.12, 8]} />
          </mesh>
        </group>
      ))}

      {/* Reaction wheels / internal detail hints */}
      <mesh material={darkMat} position={[0, 0, -0.15]}>
        <cylinderGeometry args={[0.12, 0.12, 0.08, 12]} />
      </mesh>
    </group>
  );
}

function Starfield({ count = 150 }: { count?: number }) {
  const ref = useRef<THREE.Points>(null);
  const geo = useMemo(() => {
    const rnd = mulberry(42);
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (rnd() - 0.5) * 17;
      pos[i * 3 + 1] = (rnd() - 0.5) * 9;
      pos[i * 3 + 2] = -1 - rnd() * 4;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return g;
  }, [count]);
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.z += dt * 0.004;
  });
  return (
    <points ref={ref} geometry={geo}>
      <pointsMaterial color="#7a6845" size={0.025} sizeAttenuation transparent opacity={0.8} />
    </points>
  );
}

/* Single driver: advances both orbits, aims the terminals, stretches the
   beam between their live world positions, and rides pulses both ways. */
function Rig({ reduced }: { reduced: boolean }) {
  const satA = useRef<THREE.Group>(null);
  const satB = useRef<THREE.Group>(null);
  const termA = useRef<THREE.Object3D | null>(null);
  const termB = useRef<THREE.Object3D | null>(null);
  const beamGlow = useRef<THREE.Mesh>(null);
  const beamCore = useRef<THREE.Mesh>(null);
  const pulses = useRef<Array<THREE.Mesh | null>>([]);
  const time = useRef(4.2);

  const eulerA = useMemo(() => new THREE.Euler(-0.35, 0.12, 0.42), []);
  const eulerB = useMemo(() => new THREE.Euler(0.35, -0.12, -0.42), []); // Mirror of eulerA
  const tmpA = useMemo(() => new THREE.Vector3(), []);
  const tmpB = useMemo(() => new THREE.Vector3(), []);
  const tmpC = useMemo(() => new THREE.Vector3(), []);
  // Unit cylinder pre-rotated so its axis lies on +Z: lookAt() then aims it.
  const beamGeo = useMemo(() => {
    const g = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
    g.rotateX(Math.PI / 2);
    return g;
  }, []);

  // Mirror orbits: slightly elliptical, opposite directions
  const A = { a: 1.8, b: 1.3, w: -0.35 };
  const B = { a: 1.8, b: 1.3, w: 0.35, phase: Math.PI };
  const ORIGIN = useMemo(() => new THREE.Vector3(2.8, 0.15, 0), []);

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    if (!reduced) time.current += dt;
    const t = time.current;
    if (!satA.current || !satB.current) return;

    tmpA.set(A.a * Math.cos(A.w * t), A.b * Math.sin(A.w * t), 0).applyEuler(eulerA).add(ORIGIN);
    const bp = B.w * t + B.phase;
    tmpB.set(B.a * Math.cos(bp), B.b * Math.sin(bp), 0).applyEuler(eulerB).add(ORIGIN);

    satA.current.position.copy(tmpA);
    satB.current.position.copy(tmpB);
    satA.current.lookAt(tmpB);
    satB.current.lookAt(tmpA);
    satA.current.updateMatrixWorld();
    satB.current.updateMatrixWorld();

    const pa = termA.current ? termA.current.getWorldPosition(new THREE.Vector3()) : tmpA;
    const pb = termB.current ? termB.current.getWorldPosition(new THREE.Vector3()) : tmpB;

    for (const beam of [beamGlow.current, beamCore.current]) {
      if (!beam) continue;
      tmpC.addVectors(pa, pb).multiplyScalar(0.5);
      beam.position.copy(tmpC);
      beam.lookAt(pb);
      const len = pa.distanceTo(pb);
      const r = beam === beamGlow.current ? 0.05 : 0.012;
      beam.scale.set(r, r, Math.max(len, 0.001));
    }
    pulses.current.forEach((p, i) => {
      if (!p) return;
      const dirAB = i % 2 === 0;
      const s = (t * 0.28 + (i >> 1) * 0.5) % 1;
      const k = dirAB ? s : 1 - s;
      p.position.lerpVectors(pa, pb, k);
    });
    void state;
  });

  return (
    <group>
      <group position={ORIGIN}>
        <OrbitRing a={A.a} b={A.b} rotation={[-0.35, 0.12, 0.42]} opacity={0.6} />
        <OrbitRing a={B.a} b={B.b} rotation={[0.35, -0.12, -0.42]} opacity={0.45} />
      </group>
      <group ref={satA}>
        <Satellite scale={0.65} wing={1.05} dishSide={1} termRef={termA} />
      </group>
      <group ref={satB}>
        <Satellite scale={0.55} wing={0.85} dishSide={-1} termRef={termB} />
      </group>
      <mesh ref={beamGlow} geometry={beamGeo}>
        <meshBasicMaterial color={AMBER} transparent opacity={0.16} depthWrite={false} />
      </mesh>
      <mesh ref={beamCore} geometry={beamGeo}>
        <meshBasicMaterial color={AMBER_HOT} transparent opacity={0.9} depthWrite={false} />
      </mesh>
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} ref={(m) => { pulses.current[i] = m; }}>
          <sphereGeometry args={[0.035, 10, 10]} />
          <meshBasicMaterial color={AMBER_HOT} />
        </mesh>
      ))}
    </group>
  );
}

export default function OrbitalPair3D() {
  const reduced = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );
  return (
    <Canvas
      camera={{ position: [6.5, 1.0, 5.5], fov: 32, near: 0.1, far: 60 }}
      dpr={[1, 1.5]}
      gl={{ antialias: true, alpha: false }}
      style={{ width: '100%', height: '100%', display: 'block' }}
    >
      <color attach="background" args={['#000000']} />
      <ambientLight intensity={0.8} color="#6a5a3c" />
      <directionalLight position={[4, 6, 5]} intensity={2.5} color={AMBER} />
      <directionalLight position={[-5, -2, -4]} intensity={1.2} color="#c8b8a0" />
      <pointLight position={[0.9, 0.15, 1.5]} intensity={8} distance={15} color={AMBER} />
      <pointLight position={[-2, 2, 3]} intensity={3} distance={10} color="#f5e6c8" />
      <Starfield />
      <Rig reduced={reduced} />
    </Canvas>
  );
}
