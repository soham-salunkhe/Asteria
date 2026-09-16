import { contextBridge, ipcRenderer } from 'electron';

export interface AsteriaDesktopConfig {
  apiUrl: string;
  wsUrl: string;
  copilotUrl: string;
  isPackaged: boolean;
  version: string;
}

// Controlled bridge exposing only safe desktop APIs
contextBridge.exposeInMainWorld('asteriaDesktop', {
  config: {
    apiUrl: 'http://127.0.0.1:8000',
    wsUrl: 'ws://127.0.0.1:8000/ws/simulation',
    copilotUrl: 'http://127.0.0.1:5001/api/guide',
    isPackaged: true,
    version: '1.0.0',
  } as AsteriaDesktopConfig,

  // Native Open Video dialog (MP4)
  openVideoFile: async (): Promise<{ canceled: boolean; filePath?: string; name?: string; size?: number; buffer?: Uint8Array } | null> => {
    return ipcRenderer.invoke('asteria:open-video-dialog');
  },

  // Native Save File dialog (Reports CSV/JSON/PDF)
  saveReportFile: async (defaultFilename: string, data: Uint8Array | string): Promise<{ success: boolean; filePath?: string; canceled?: boolean }> => {
    return ipcRenderer.invoke('asteria:save-report-dialog', { defaultFilename, data });
  },

  // Window Controls
  minimize: () => ipcRenderer.send('asteria:window-minimize'),
  maximize: () => ipcRenderer.send('asteria:window-maximize'),
  close: () => ipcRenderer.send('asteria:window-close'),
  isMaximized: () => ipcRenderer.invoke('asteria:window-is-maximized'),

  // Environment info
  getAppVersion: () => ipcRenderer.invoke('asteria:get-version'),
});

// Update config dynamically once main process resolves dynamic ports
ipcRenderer.on('asteria:init-config', (_event, cfg: AsteriaDesktopConfig) => {
  const target = (window as any).asteriaDesktop;
  if (target) {
    target.config = cfg;
  }
});
