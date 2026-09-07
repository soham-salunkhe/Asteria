/**
 * FSOC Virtual PAT — WebSocket Client
 * In development, Vite proxies /ws to ws://localhost:8000.
 * In production, set VITE_FSOC_WS_URL explicitly.
 */
import type { TelemetryFrame } from '../types/fsoc';

const FSOC_WS = import.meta.env.VITE_FSOC_WS_URL
  ?? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/simulation`;

type FrameCallback = (frame: TelemetryFrame) => void;
type StatusCallback = (status: 'connected' | 'disconnected' | 'error') => void;

class SimulationWebSocket {
  private _ws: WebSocket | null = null;
  private _onFrame: FrameCallback | null = null;
  private _onStatus: StatusCallback | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectDelay = 2000;
  private _shouldReconnect = true;
  private _connected = false;

  connect(onFrame: FrameCallback, onStatus?: StatusCallback): void {
    this._onFrame = onFrame;
    this._onStatus = onStatus ?? null;
    this._shouldReconnect = true;
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
    try {
      this._ws = new WebSocket(FSOC_WS);

      this._ws.onopen = () => {
        this._connected = true;
        this._reconnectDelay = 2000;
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
        this._onStatus?.('error');
      };

      this._ws.onclose = () => {
        this._connected = false;
        this._onStatus?.('disconnected');
        if (this._shouldReconnect) {
          this._reconnectTimer = setTimeout(() => {
            this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, 15000);
            this._open();
          }, this._reconnectDelay);
        }
      };
    } catch {
      this._onStatus?.('error');
      if (this._shouldReconnect) {
        this._reconnectTimer = setTimeout(() => this._open(), this._reconnectDelay);
      }
    }
  }
}

// Singleton — one connection for the whole app
export const simulationWS = new SimulationWebSocket();
