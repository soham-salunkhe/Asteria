/**
 * FSOC — Gemini Engineering Copilot
 * Full-page engineering analysis assistant.
 * Receives live telemetry as context so it can give grounded answers.
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useSimulation } from '../../hooks/useSimulation';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

type Turn = { role: 'user' | 'model'; parts: [{ text: string }] };

function toGeminiHistory(msgs: Message[]): Turn[] {
  return msgs.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

const API_BASE = import.meta.env.VITE_API_URL ?? '';

const QUICK_PROMPTS = [
  'Why did tracking error increase?',
  'Which disturbance affected the system most?',
  'Explain the PID response in the last run.',
  'How can I improve lock retention?',
  'Why was the target lost?',
  'Compare acquisition time against typical FSOC systems.',
  'What caused the maximum tracking error?',
  'Suggest optimal Kalman filter parameters for this scenario.',
];

export function CopilotPage() {
  const sim = useSimulation();
  const f   = sim.latest;
  const met = f?.metrics;
  const err = f?.angular_error;

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput]       = useState('');
  const [sending, setSending]   = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  // Build telemetry context block for Gemini
  const buildContext = useCallback((): string => {
    if (!f) return 'No telemetry available — simulation not running.';
    const d = f.disturbance;
    const active = [];
    if (d?.config?.atmospheric_turbulence?.enabled) active.push(`atmospheric turbulence (strength=${d.config.atmospheric_turbulence.strength})`);
    if (d?.config?.platform_vibration?.enabled)    active.push(`platform vibration (amp=${d.config.platform_vibration.amplitude}°)`);
    if (d?.config?.camera_motion?.enabled)         active.push('camera motion');
    if (d?.config?.sensor_noise?.enabled)          active.push('sensor noise');
    if (d?.config?.target_motion_variation?.enabled) active.push('target motion variation');

    return `
FSOC VIRTUAL PAT — Live Telemetry Context
==========================================
Simulation Status:   ${f.sim_status}
Target State:        ${f.target_state}
Elapsed:             ${f.elapsed.toFixed(2)} s
Frame:               ${f.frame_id}

CAMERA:
  Pan:               ${f.camera.pan.toFixed(3)}°
  Tilt:              ${f.camera.tilt.toFixed(3)}°

ANGULAR ERROR:
  Pan Error:         ${err?.pan_error?.toFixed(4) ?? '—'}°
  Tilt Error:        ${err?.tilt_error?.toFixed(4) ?? '—'}°
  Total Error:       ${err?.total_error?.toFixed(4) ?? '—'}°

DETECTION:
  Confidence:        ${f.detection ? (f.detection.confidence * 100).toFixed(1) + '%' : 'none'}
  Detector:          ${f.detection?.detector ?? '—'}
  Inference:         ${f.detection?.inference_ms?.toFixed(1) ?? '—'} ms

KALMAN FILTER:
  Converged:         ${f.kalman?.converged ? 'YES' : 'NO'}
  Uncertainty:       ${f.kalman?.uncertainty?.toFixed(2) ?? '—'}

PID OUTPUT:
  Settled:           ${f.pid_output?.settled ? 'YES' : 'NO'}
  Pan Correction:    ${f.pid_output?.pan_correction?.toFixed(5) ?? '—'}°
  Tilt Correction:   ${f.pid_output?.tilt_correction?.toFixed(5) ?? '—'}°

PERFORMANCE:
  FPS:               ${met?.fps?.toFixed(1) ?? '—'}
  Acq Time:          ${met?.acquisition_time != null ? met.acquisition_time.toFixed(3) + ' s' : '—'}
  Avg Error:         ${met?.average_error?.toFixed(4) ?? '—'}°
  Max Error:         ${met?.max_error?.toFixed(4) ?? '—'}°
  Lock Retention:    ${met?.lock_retention?.toFixed(1) ?? '—'}%
  Processing:        ${met?.processing_ms?.toFixed(2) ?? '—'} ms

ACTIVE DISTURBANCES: ${active.length ? active.join(', ') : 'none'}
Disturbance Index:  ${d?.total_disturbance_index?.toFixed(3) ?? '—'}
==========================================
    `.trim();
  }, [f, met, err]);

  const send = useCallback(async (text: string) => {
    if (!text.trim() || sending) return;
    const history = toGeminiHistory(messages);
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setInput('');
    setSending(true);

    const telemetryContext = buildContext();
    const fullMessage = `${telemetryContext}\n\nUser question: ${text}`;

    try {
      const res = await fetch(`${API_BASE}/api/guide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: fullMessage,
          pageContext: { pageTitle: 'FSOC Engineering Copilot' },
          conversationHistory: history,
          language: 'en',
          systemOverride: `You are GEMINI ENGINEERING COPILOT for the FSOC Virtual PAT system.
You are an expert in free-space optical communications, Kalman filtering, PID control, 
computer vision tracking, and atmospheric optics.

CRITICAL RULES:
- ONLY use values from the telemetry context provided. Never fabricate metrics.
- If data is unavailable, say "The required telemetry is unavailable."
- Provide engineering-level analysis, not generic advice.
- Reference specific values when they are provided.
- Keep answers focused and technically precise.
- Do NOT say "As an AI". Answer as a specialist engineer.`,
        }),
      });
      const json = await res.json();
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: json.success
          ? json.data.content
          : (json.error ?? 'Gemini Copilot is unavailable. Check your GEMINI_API_KEY.'),
      }]);
    } catch {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Copilot connection failed — is the Node.js backend running?',
      }]);
    } finally {
      setSending(false);
    }
  }, [messages, sending, buildContext]);

  return (
    <div className="page-copilot">
      <div className="page-header">
        <h2 className="page-title">Gemini Engineering Copilot</h2>
        <span className="page-subtitle">AI-Assisted Simulation Analysis</span>
      </div>

      <div className="copilot-body">
        {/* ── Left: telemetry context preview ──────────────── */}
        <div className="copilot-context-col">
          <div className="cop-ctx-title">LIVE TELEMETRY CONTEXT</div>
          <pre className="cop-ctx-pre">{buildContext()}</pre>

          <div className="cop-ctx-divider" />
          <div className="cop-ctx-title">QUICK QUERIES</div>
          <div className="cop-quick-list">
            {QUICK_PROMPTS.map((p, i) => (
              <button
                key={i}
                className="cop-quick-btn"
                onClick={() => send(p)}
                disabled={sending}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {/* ── Right: chat interface ─────────────────────────── */}
        <div className="copilot-chat-col">
          <div className="cop-messages">
            {messages.length === 0 && (
              <div className="cop-welcome">
                <div className="cop-welcome-title">GEMINI ENGINEERING COPILOT</div>
                <p className="cop-welcome-sub">
                  Ask questions about the simulation. The copilot receives live telemetry
                  and will only reference measured values — it will not fabricate data.
                </p>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={`cop-msg cop-msg-${m.role}`}>
                <span className="cop-msg-role">
                  {m.role === 'user' ? 'OPERATOR' : 'COPILOT'}
                </span>
                <div className="cop-msg-content">{m.content}</div>
              </div>
            ))}

            {sending && (
              <div className="cop-msg cop-msg-assistant">
                <span className="cop-msg-role">COPILOT</span>
                <div className="cop-typing">
                  <span />
                  <span />
                  <span />
                  <span className="cop-typing-label">analysing telemetry…</span>
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          <form
            className="cop-input-row"
            onSubmit={e => { e.preventDefault(); send(input); }}
          >
            <input
              ref={inputRef}
              className="cop-input"
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Ask about tracking error, PID response, disturbance impact…"
              disabled={sending}
              autoComplete="off"
            />
            <button
              type="submit"
              className="cop-send-btn"
              disabled={!input.trim() || sending}
            >
              ⏎
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
