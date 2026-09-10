import { useEffect, useRef } from 'react';
import './AeroShards.css';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function colorToRgb(value) {
  const hex = value.replace('#', '');
  const normalized = hex.length === 3 ? hex.split('').map(char => char + char).join('') : hex;
  const parsed = Number.parseInt(normalized, 16);
  return {
    r: (parsed >> 16) & 255,
    g: (parsed >> 8) & 255,
    b: parsed & 255,
  };
}

function mulberry32(seed) {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * AeroShards-compatible canvas field. It keeps the React Bits prop surface
 * used by the landing page while avoiding a hard dependency on WebGPU.
 */
export default function AeroShards({
  backgroundColor = '#120F17',
  shardColor = '#896ABD',
  accentColor = '#A855F7',
  speed = 1,
  spin = 1,
  density = 1.5,
  shardSize = 1.1,
  stretch = 1,
  turbulence = 1,
  glow = 1,
  interaction = 'repel',
  interactionRadius = 1.5,
  interactionStrength = 0.5,
  paused = false,
  className = '',
  onError,
}) {
  const rootRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return undefined;

    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('2D canvas is not available');
      const random = mulberry32(17);
      const pointer = { x: -1000, y: -1000, active: false };
      const count = Math.round(clamp(180 * density, 90, 360));
      const shards = Array.from({ length: count }, () => ({
        phase: random(),
        lane: random() * 2 - 1,
        depth: 0.35 + random() * 0.9,
        length: 4 + random() * 16,
        width: 0.35 + random() * 1.15,
        tilt: random() * Math.PI,
        drift: random() * Math.PI * 2,
      }));
      const base = colorToRgb(shardColor);
      const accent = colorToRgb(accentColor);
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      let frameId = 0;
      let lastTime = performance.now();
      let width = 1;
      let height = 1;
      let dpr = 1;

      const resize = () => {
        const rect = root.getBoundingClientRect();
        width = Math.max(1, rect.width);
        height = Math.max(1, rect.height);
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
      };

      const resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(root);
      resize();

      const updatePointer = event => {
        const rect = root.getBoundingClientRect();
        pointer.x = event.clientX - rect.left;
        pointer.y = event.clientY - rect.top;
        pointer.active = true;
      };
      const clearPointer = () => { pointer.active = false; };
      root.addEventListener('pointermove', updatePointer);
      root.addEventListener('pointerleave', clearPointer);

      const render = now => {
        const delta = Math.min(0.04, Math.max(0.001, (now - lastTime) / 1000));
        lastTime = now;
        const travel = reduceMotion || paused ? 0 : delta * speed * 0.12;
        context.clearRect(0, 0, width, height);
        context.fillStyle = backgroundColor;
        context.fillRect(0, 0, width, height);

        for (const shard of shards) {
          shard.phase = (shard.phase + travel / shard.depth) % 1;
          const x = (shard.phase * (width + 220)) - 110;
          const wave = Math.sin(shard.phase * Math.PI * 2.3 + shard.drift) * height * 0.15 * turbulence;
          const y = height * (0.56 + shard.lane * 0.34) + wave;
          const repel = interaction === 'repel' && pointer.active;
          const attract = interaction === 'attract' && pointer.active;
          const dx = x - pointer.x;
          const dy = y - pointer.y;
          const distance = Math.hypot(dx, dy);
          const reach = Math.max(width, height) * interactionRadius * 0.35;
          const influence = repel || attract ? clamp(1 - distance / reach, 0, 1) * interactionStrength : 0;
          const direction = repel ? 1 : -1;
          const offsetX = distance ? (dx / distance) * influence * 42 * direction : 0;
          const offsetY = distance ? (dy / distance) * influence * 42 * direction : 0;
          const finalX = x + offsetX;
          const finalY = y + offsetY;
          const length = shard.length * shardSize * (0.7 + shard.depth * 0.35) * stretch;
          const rotation = shard.tilt + Math.sin(now * 0.0008 * spin + shard.drift) * 0.2;
          const mix = clamp(0.18 + shard.depth * 0.42 + influence * 0.6, 0, 1);
          const color = {
            r: Math.round(base.r + (accent.r - base.r) * mix),
            g: Math.round(base.g + (accent.g - base.g) * mix),
            b: Math.round(base.b + (accent.b - base.b) * mix),
          };
          context.save();
          context.translate(finalX, finalY);
          context.rotate(rotation);
          context.globalAlpha = (0.12 + shard.depth * 0.34) + influence * 0.35;
          context.strokeStyle = `rgb(${color.r} ${color.g} ${color.b})`;
          context.lineWidth = shard.width;
          if (glow > 0 && influence > 0.05) {
            context.shadowBlur = 12 * glow;
            context.shadowColor = `rgba(${accent.r}, ${accent.g}, ${accent.b}, .4)`;
          }
          context.beginPath();
          context.moveTo(-length, 0);
          context.lineTo(length, 0);
          context.stroke();
          context.restore();
        }

        frameId = requestAnimationFrame(render);
      };

      root.dataset.ready = 'true';
      frameId = requestAnimationFrame(render);
      return () => {
        cancelAnimationFrame(frameId);
        resizeObserver.disconnect();
        root.removeEventListener('pointermove', updatePointer);
        root.removeEventListener('pointerleave', clearPointer);
      };
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error('AeroShards failed to initialise'));
      return undefined;
    }
  }, [accentColor, backgroundColor, density, glow, interaction, interactionRadius, interactionStrength, onError, paused, shardColor, shardSize, speed, spin, stretch, turbulence]);

  return <div ref={rootRef} className={`aero-shards ${className}`} style={{ backgroundColor }} aria-hidden="true"><canvas ref={canvasRef} className="aero-shards__canvas" /></div>;
}
