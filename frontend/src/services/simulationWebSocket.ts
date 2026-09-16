/**
 * FSOC Virtual PAT — WebSocket Client
 * In development, Vite proxies /ws to ws://localhost:8000.
 * In production, set VITE_FSOC_WS_URL explicitly.
 */
import type { TelemetryFrame } from '../types/fsoc';

export function getWsUrl(): string {
  if (typeof window !== 'undefined' && (window as any).asteriaDesktop?.config?.wsUrl) {
    return (window as any).asteriaDesktop.config.wsUrl;
  }
  if (import.meta.env.VITE_FSOC_WS_URL) {
    return import.meta.env.VITE_FSOC_WS_URL;
  }
  if (typeof window !== 'undefined' && window.location.protocol === 'file:') {
    return 'ws://127.0.0.1:8000/ws/simulation';
  }
  return `${typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws'}://${typeof window !== 'undefined' ? window.location.host : 'localhost:8000'}/ws/simulation`;
}

type FrameCallback = (frame: TelemetryFrame) => void;
type StatusCallback = (status: 'connected' | 'disconnected' | 'error') => void;

class SimulationWebSocket {
  private _ws: WebSocket | null = null;
  private _onFrame: FrameCallback | null = null;
  private _onStatus: StatusCallback | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectDelay = 3000; // Increased from 2s to 3s
  private _shouldReconnect = true;
  private _connected = false;
  private _isReconnecting = false;

  connect(onFrame: FrameCallback, onStatus?: StatusCallback): void {
    this._onFrame = onFrame;
    this._onStatus = onStatus ?? null;
    this._shouldReconnect = true;
    // Upload processing may begin before route navigation finishes.  Open
    // immediately so the first real decoded frame is not missed.
    this._open();
  }

  disconnect(): void {
    this._shouldReconnect = false;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._ws?.close();
    this._ws = null;
  }

  send(type: string, payload: unknown): void {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type, payload }));
    }
  }

  get isConnected(): boolean {
    return this._connected;
  }

  private _open(): void {
    // Prevent multiple simultaneous connection attempts
    if (this._isReconnecting) return;
    this._isReconnecting = true;

    try {
      this._ws = new WebSocket(getWsUrl());

      this._ws.onopen = () => {
        this._connected = true;
        this._reconnectDelay = 3000;
        this._isReconnecting = false;
        this._onStatus?.('connected');
      };

      this._ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data as string) as { type: string; payload: unknown };
          if (msg.type === 'telemetry') {
            this._onFrame?.(msg.payload as TelemetryFrame);
          }
          // ping/status messages are silently consumed
        } catch {
          // malformed frame — ignore
        }
      };

      this._ws.onerror = () => {
        this._isReconnecting = false;
        this._onStatus?.('error');
      };

      this._ws.onclose = () => {
        this._connected = false;
        this._isReconnecting = false;
        this._onStatus?.('disconnected');
        if (this._shouldReconnect && !this._reconnectTimer) {
          this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, 30000);
            this._open();
          }, this._reconnectDelay);
        }
      };
    } catch {
      this._isReconnecting = false;
      this._onStatus?.('error');
      if (this._shouldReconnect && !this._reconnectTimer) {
        this._reconnectTimer = setTimeout(() => {
          this._reconnectTimer = null;
          this._open();
        }, this._reconnectDelay);
      }
    }
  }
}

// Singleton — one connection for the whole app
export const simulationWS = new SimulationWebSocket();
