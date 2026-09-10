import { Link, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import './LandingPage.css';

/* ── Palette (spec) ────────────────────────────────────────── */
const AMBER = '#e8a33d';

function CrosshairMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`system-mark${compact ? ' system-mark--compact' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 36 36" fill="none" shapeRendering="crispEdges">
        <circle cx="18" cy="18" r="12" stroke={AMBER} strokeWidth="1.5" />
        <circle cx="18" cy="18" r="6.5" stroke={AMBER} strokeWidth="1" opacity=".65" />
        <path d="M18 0v8M18 28v8M0 18h8M28 18h8" stroke={AMBER} strokeWidth="1.5" />
        <rect x="16.5" y="16.5" width="3" height="3" fill={AMBER} />
      </svg>
    </span>
  );
}

function Chevron() {
  return <span className="lp-button-arrow" aria-hidden="true">→</span>;
}

/* ── 1-bit pixel headline: text is rasterized tiny, thresholded to
      hard on/off blocks, then upscaled with smoothing OFF so every
      pixel is a chunky uniform square (no webfont dependency). ─── */
const HEADLINE_LINES = ['TRACK', 'BEYOND', 'BOUNDARIES'];

function PixelHeadline() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [blink, setBlink] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setBlink((b) => !b), 530);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    let raf = 0;
    let dead = false;

    const draw = () => {
      const FONT = 32;
      const LINE_H = 52;
      const PAD = 4;
      const GAP = 8;
      const CURSOR_W = Math.round(FONT * 0.8);

      const meas = document.createElement('canvas').getContext('2d');
      if (!meas) return;
      const applyFont = (c: CanvasRenderingContext2D) => {
        c.font = `${FONT}px "Press Start 2P", "Courier New", monospace`;
        c.textBaseline = 'top';
        c.textAlign = 'left';
      };
      applyFont(meas);
      const widths = HEADLINE_LINES.map((l) => Math.ceil(meas.measureText(l).width));
      const lastW = widths[widths.length - 1];
      const lowW = Math.max(...widths, lastW + GAP + CURSOR_W) + PAD * 2;
      const lowH = LINE_H * HEADLINE_LINES.length + PAD * 2;

      const targetW = Math.max(160, Math.floor(wrap.clientWidth));
      const scale = Math.max(1, Math.floor(targetW / lowW));

      const off = document.createElement('canvas');
      off.width = lowW;
      off.height = lowH;
      const o = off.getContext('2d');
      if (!o) return;
      o.imageSmoothingEnabled = false;
      applyFont(o);
      o.fillStyle = '#ffffff';
      HEADLINE_LINES.forEach((l, i) => o.fillText(l, PAD, PAD + i * LINE_H));
      if (blink) {
        o.fillRect(PAD + lastW + GAP, PAD + (HEADLINE_LINES.length - 1) * LINE_H, CURSOR_W, FONT + 6);
      }

      // threshold alpha → hard 1-bit amber blocks
      const img = o.getImageData(0, 0, lowW, lowH);
      const px = img.data;
      for (let i = 0; i < px.length; i += 4) {
        const on = px[i + 3] > 100;
        px[i] = 232; px[i + 1] = 163; px[i + 2] = 61;
        px[i + 3] = on ? 255 : 0;
      }
      o.putImageData(img, 0, 0);

      // crop to drawn content so zero dead rows sit between the
      // headline and the copy below. Bottom always includes the
      // cursor zone so the box never jumps as it blinks.
      const cursorBottom = PAD + (HEADLINE_LINES.length - 1) * LINE_H + FONT + 6;
      let topRow = lowH;
      outer: for (let y = 0; y < lowH; y++) {
        for (let x = 0; x < lowW; x += 2) {
          if (px[(y * lowW + x) * 4 + 3] > 0) { topRow = y; break outer; }
        }
      }
      if (topRow >= lowH) topRow = 0;
      const cropTop = Math.max(0, topRow - 1);
      const cropBot = Math.min(lowH, cursorBottom + 2);
      const cropH = Math.max(1, cropBot - cropTop);

      // dark offset shadow for pixel depth
      const sh = document.createElement('canvas');
      sh.width = lowW;
      sh.height = lowH;
      const s = sh.getContext('2d');
      if (!s) return;
      s.drawImage(off, 0, 0);
      s.globalCompositeOperation = 'source-in';
      s.fillStyle = '#6b3d0e';
      s.fillRect(0, 0, lowW, lowH);

      canvas.width = lowW * scale;
      canvas.height = cropH * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      const ox = Math.max(1, Math.round(scale * 0.7));
      const oy = Math.max(1, Math.round(scale * 0.9));
      const dw = lowW * scale;
      const dh = cropH * scale;
      ctx.drawImage(sh, 0, cropTop, lowW, cropH, ox, oy, dw, dh);
      ctx.drawImage(off, 0, cropTop, lowW, cropH, 0, 0, dw, dh);
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
    };

    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    });
    ro.observe(wrap);
    try {
      const p =       document.fonts?.load('32px "Press Start 2P"') as Promise<unknown> | undefined;
      (p as Promise<unknown> | undefined)?.catch(() => {}).finally?.(() => { if (!dead) draw(); });
    } catch { /* fallback font still pixelates */ }
    draw();
    return () => { dead = true; ro.disconnect(); cancelAnimationFrame(raf); };
  }, [blink]);

  return (
    <div ref={wrapRef} className="px-headline-wrap">
      <canvas ref={canvasRef} className="px-headline-canvas" aria-hidden="true" />
    </div>
  );
}

/* Ground target sits on the earth artwork's rim (artwork: public/earth.png,
   placed at x=0 y=143 w=1600 h=1067 — rim lands at viewBox y≈768) */
const CROSS = { x: 1180, y: 662 };

function PixelSatellite() {
  // satellite artwork frame (public/satellite.png, 3:2) + beam origin at its dish
  const BEAM_X = 1010;
  const BEAM_Y = 371;

  return (
    <div className="lp-diagram" aria-label="Satellite beaming to a ground target above a dithered planet curve">

      <svg
        viewBox="0 0 1600 900"
        preserveAspectRatio="xMidYMax slice"
        role="img"
        aria-label="Satellite, laser beam, crosshair and earth horizon"
        shapeRendering="crispEdges"
        className="px-svg"
      >
        {/* ── earth artwork (black melts away, arc grounds on the page bottom) ── */}
        <image
          href="/earth.png"
          x={607} y={236} width={1000} height={667}
          preserveAspectRatio="xMidYMid meet"
          className="px-photo px-earth"
        />
        {/* ── satellite artwork (amber line art on black — blends via screen) ── */}
        <image
          href="/satellite.png"
          x={837} y={194} width={416} height={277}
          preserveAspectRatio="xMidYMid meet"
          className="px-photo"
        />

        {/* ── dashed laser beam satellite → ground ── */}
        <line
          x1={BEAM_X} y1={BEAM_Y} x2={CROSS.x} y2={CROSS.y - 30}
          className="px-beam px-beam-glow"
        />
        <line
          x1={BEAM_X} y1={BEAM_Y} x2={CROSS.x} y2={CROSS.y - 30}
          className="px-beam"
        />
        {/* data packets riding the beam down to the target */}
        {[0, -1.2].map((b, i) => (
          <rect key={i} x={-4} y={-4} width={8} height={8} className="px-packet">
            <animateMotion
              dur="2.4s"
              begin={`${b}s`}
              repeatCount="indefinite"
              path={`M ${BEAM_X} ${BEAM_Y} L ${CROSS.x} ${CROSS.y - 34}`}
            />
          </rect>
        ))}

        {/* ── crosshair target ── */}
        <g transform={`translate(${CROSS.x} ${CROSS.y}) scale(1.15)`} className="px-cross">
          <path d="M-34 0H34M0-34V34" />
          <rect x="-17" y="-17" width="34" height="34" />
          <rect x="-26" y="-26" width="52" height="52" opacity=".55" />
          <rect x="-7" y="-7" width="14" height="14" />
          <rect x="-3" y="-3" width="6" height="6" className="px-solid px-core" />
        </g>

      </svg>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="lp-section-label"><span aria-hidden="true" />{children}</p>;
}

export function LandingPage() {
  const navigate = useNavigate();
  const { isLoggedIn } = useAuth();
  const launch = () => navigate(isLoggedIn ? '/mission' : '/login');

  return (
    <div className="lp-root">
      <div className="lp-scanlines" aria-hidden="true" />
      <header className="lp-nav">
        <div className="lp-nav-inner">
          <Link to="/" className="lp-brand" aria-label="Asteria home">
            <CrosshairMark compact />
            <span>ASTERIA <small>v1.0.0</small></span>
          </Link>
          <nav className="lp-links" aria-label="Primary navigation">
            <a href="#home" className="lp-link lp-link--active">[ HOME ]</a>
            <a href="#technology" className="lp-link">[ TECHNOLOGY ]</a>
            <a href="#mission" className="lp-link">[ MISSION ]</a>
            <a href="#about" className="lp-link">[ ABOUT ]</a>
          </nav>
          <button className="lp-launch-btn" onClick={launch}>LAUNCH SYSTEM <Chevron /></button>
        </div>
      </header>

      <main>
        <section id="home" className="lp-hero">
          <PixelSatellite />
          <div className="lp-hero-inner">
            <div className="lp-hero-copy">
              <span className="lp-dash" aria-hidden="true" />
              <h1 className="lp-headline" aria-label="Track beyond boundaries">
                <PixelHeadline />
              </h1>
              <p className="lp-subtitle">A VIRTUAL CAMERA TRACKING SYSTEM<br />FOR FREE-SPACE OPTICAL COMMUNICATION</p>
              <button className="lp-primary-btn" onClick={launch}>LAUNCH SYSTEM <Chevron /></button>
            </div>
          </div>
        </section>

        <section id="technology" className="lp-overview-section">
          <div className="lp-section-heading">
            <SectionLabel>01 / TECHNOLOGY</SectionLabel>
            <h2>OPTICAL LINK<br /><em>ACQUISITION.</em></h2>
          </div>
          <div className="lp-overview-copy">
            <p>A virtual optical tracking environment built to simulate target acquisition, camera alignment, and closed-loop correction before a physical link is deployed.</p>
            <div className="lp-telemetry-list">
              <span>DETECTION <b>AI-ASSISTED</b></span>
              <span>PREDICTION <b>KALMAN FILTER</b></span>
              <span>CONTROL <b>VIRTUAL PAN-TILT</b></span>
            </div>
          </div>
        </section>

        <section id="mission" className="lp-pipeline-section">
          <SectionLabel>02 / MISSION SEQUENCE</SectionLabel>
          <div className="lp-pipeline" role="list" aria-label="Mission sequence">
            {['ENVIRONMENT', 'CAMERA', 'DETECTION', 'TRACKING', 'ANALYTICS'].map((stage, index) => (
              <div className="lp-pipeline-stage" role="listitem" key={stage}>
                <span>0{index + 1}</span><strong>{stage}</strong><i aria-hidden="true">→</i>
              </div>
            ))}
          </div>
        </section>

        <section id="about" className="lp-access-section">
          <CrosshairMark />
          <div><SectionLabel>03 / SYSTEM READY</SectionLabel><h2>RUN THE MISSION<span className="lp-cursor">_</span></h2></div>
          <button className="lp-primary-btn" onClick={launch}>ENTER CONTROL <Chevron /></button>
        </section>
      </main>
    </div>
  );
}

export default LandingPage;
