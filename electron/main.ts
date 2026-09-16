import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import { spawn, exec, ChildProcess } from 'child_process';
import net from 'net';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';

let mainWindow: BrowserWindow | null = null;
let engineProcess: ChildProcess | null = null;
let copilotServer: http.Server | null = null;

let enginePort = 8000;
let copilotPort = 5001;

// Set authoritative application identity
app.setName('ASTERIA');
const appData = app.getPath('appData');
const userDataDir = path.join(appData, 'ASTERIA');
app.setPath('userData', userDataDir);

// ── Application paths & logging ───────────────────────────────
const logsDir = path.join(userDataDir, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const appLogStream = fs.createWriteStream(path.join(logsDir, 'application.log'), { flags: 'a' });
const engineLogStream = fs.createWriteStream(path.join(logsDir, 'tracking.log'), { flags: 'a' });

function log(msg: string) {
  const line = `[${new Date().toISOString()}] [MAIN] ${msg}\n`;
  if (!app.isPackaged) console.log(line.trim());
  appLogStream.write(line);
}

// ── Port utility ──────────────────────────────────────────────
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(startPort: number, maxAttempts = 20): Promise<number> {
  for (let p = startPort; p < startPort + maxAttempts; p++) {
    if (await isPortAvailable(p)) return p;
  }
  return startPort;
}

// ── Start embedded Gemini Copilot proxy ────────────────────────
async function startCopilotServer(port: number): Promise<number> {
  const expressApp = express();
  expressApp.use(cors({ origin: '*' }));
  expressApp.use(express.json());

  const SYSTEM_PROMPT = `You are GEMINI ENGINEERING COPILOT for the FSOC Virtual PAT (Free-Space Optical Communication Pointing, Acquisition & Tracking) system.
You are an expert in FSOC, Kalman filtering, PID control, and YOLO computer vision. Reference live telemetry values if provided.`;

  expressApp.post('/api/guide', async (req, res) => {
    const { message, pageContext, conversationHistory } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ success: false, error: 'Message is required.' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'your_gemini_api_key_here') {
      return res.status(503).json({
        success: false,
        error: 'GEMINI_API_KEY is not configured. Telemetry tracking functions offline.',
      });
    }

    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: 'gemini-1.5-flash',
        systemInstruction: SYSTEM_PROMPT,
      });

      const prompt = `${pageContext ? `Context: ${JSON.stringify(pageContext)}\n` : ''}${message}`;
      const result = await model.generateContent(prompt);
      const reply = result.response.text();
      return res.json({ success: true, reply });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message || 'Copilot error' });
    }
  });

  expressApp.get('/api/health', (_req, res) => {
    res.json({ status: 'healthy', service: 'asteria-embedded-copilot', version: '1.0.0' });
  });

  return new Promise((resolve) => {
    copilotServer = expressApp.listen(port, '127.0.0.1', () => {
      log(`Embedded Copilot server listening on http://127.0.0.1:${port}`);
      resolve(port);
    });
  });
}

// ── Tracking Engine (Python FastAPI) process ──────────────────
function getTrackingEnginePath(): string {
  if (app.isPackaged) {
    // Packaged with electron-builder extraResources: resources/bin/tracking-engine/tracking-engine.exe
    const p1 = path.join(process.resourcesPath, 'bin', 'tracking-engine', 'tracking-engine.exe');
    if (fs.existsSync(p1)) return p1;
    const p2 = path.join(process.resourcesPath, 'tracking-engine', 'tracking-engine.exe');
    if (fs.existsSync(p2)) return p2;
    return p1;
  }
  return path.join(__dirname, '..', 'ai-service', 'dist', 'tracking-engine', 'tracking-engine.exe');
}

async function startTrackingEngine(port: number): Promise<void> {
  const exePath = getTrackingEnginePath();
  log(`Starting tracking engine from: ${exePath} on port ${port}`);

  if (!fs.existsSync(exePath)) {
    log(`WARNING: Tracking engine binary not found at ${exePath}. Simulation API may not start.`);
    return;
  }

  const env = {
    ...process.env,
    ASTERIA_DATA_DIR: userDataDir,
  };

  try {
    engineProcess = spawn(exePath, ['--host', '127.0.0.1', '--port', String(port)], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    engineProcess.stdout?.on('data', (data) => {
      engineLogStream.write(data);
    });

    engineProcess.stderr?.on('data', (data) => {
      engineLogStream.write(data);
    });

    engineProcess.on('exit', (code, signal) => {
      log(`Tracking engine exited with code: ${code}, signal: ${signal}`);
      engineProcess = null;
    });

    log(`Tracking engine process spawned (PID: ${engineProcess.pid})`);
  } catch (err: any) {
    log(`Failed to spawn tracking engine: ${err.message}`);
  }
}

function stopProcesses(): void {
  if (copilotServer) {
    try {
      copilotServer.close();
      log('Embedded Copilot server stopped.');
    } catch {
      // ignore
    }
    copilotServer = null;
  }

  if (engineProcess && engineProcess.pid) {
    const pid = engineProcess.pid;
    log(`Terminating tracking engine PID ${pid}...`);
    try {
      // Force kill entire process tree on Windows
      exec(`taskkill /PID ${pid} /T /F`, (err) => {
        if (err) log(`taskkill error: ${err.message}`);
        else log(`Successfully terminated tracking engine tree PID ${pid}`);
      });
    } catch (e: any) {
      log(`Kill error: ${e.message}`);
    }
    engineProcess = null;
  }
}

// ── Create Main Window ─────────────────────────────────────────
async function createWindow(): Promise<void> {
  // Discover available ports
  enginePort = await findAvailablePort(8000);
  copilotPort = await findAvailablePort(5001);

  // Start backends
  await startTrackingEngine(enginePort);
  await startCopilotServer(copilotPort);

  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'resources', 'icon.ico')
    : path.join(__dirname, '..', 'resources', 'icon.ico');

  mainWindow = new BrowserWindow({
    title: 'ASTERIA — FSOC Mission Control',
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#05070d',
    show: false,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: true,
    },
  });

  // Remove default menu for sleek aerospace look
  Menu.setApplicationMenu(null);

  const config = {
    apiUrl: `http://127.0.0.1:${enginePort}`,
    wsUrl: `ws://127.0.0.1:${enginePort}/ws/simulation`,
    copilotUrl: `http://127.0.0.1:${copilotPort}/api/guide`,
    isPackaged: app.isPackaged,
    version: app.getVersion(),
  };

  const showWindow = () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
      log('ASTERIA Mission Control window displayed.');
    }
  };

  // Attach ready-to-show listener BEFORE loading so it is never missed
  mainWindow.once('ready-to-show', () => {
    log('Window event: ready-to-show fired');
    showWindow();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    log('Window event: did-finish-load fired');
    mainWindow?.webContents.send('asteria:init-config', config);
    showWindow();
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    log(`[RENDERER FAIL-LOAD] code: ${errorCode}, desc: ${errorDescription}, url: ${validatedURL}`);
    showWindow();
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    log(`[RENDERER-LOG] [lvl:${level}] ${message} (${sourceId}:${line})`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`[RENDER-PROCESS-GONE] reason: ${details.reason}, exitCode: ${details.exitCode}`);
  });

  // Safety fallback: guaranteed window display after 2.5s
  const showFallbackTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      log('Safety fallback triggered: forcing window show.');
      showWindow();
    }
  }, 2500);

  const isDev = process.argv.includes('--dev') || (!app.isPackaged && process.env.NODE_ENV === 'development');

  try {
    if (isDev) {
      log('Loading dev server URL: http://localhost:5173');
      await mainWindow.loadURL('http://localhost:5173');
    } else {
      let indexPath = path.join(app.getAppPath(), 'frontend', 'dist', 'index.html');
      if (!fs.existsSync(indexPath)) {
        const candidate2 = path.join(__dirname, '..', 'frontend', 'dist', 'index.html');
        if (fs.existsSync(candidate2)) {
          indexPath = candidate2;
        }
      }
      log(`Loading production build: ${indexPath} (exists: ${fs.existsSync(indexPath)})`);
      await mainWindow.loadFile(indexPath);
    }
  } catch (err: any) {
    log(`Failed to load URL/file: ${err.message}`);
    showWindow();
  }

  // Final check right after loadFile returns
  showWindow();

  mainWindow.on('closed', () => {
    clearTimeout(showFallbackTimer);
    mainWindow = null;
  });
}

// ── IPC Handlers ──────────────────────────────────────────────
ipcMain.handle('asteria:open-video-dialog', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select FSOC Sensor Benchmark MP4 Video',
    filters: [
      { name: 'MP4 Video (*.mp4)', extensions: ['mp4'] },
      { name: 'All Video Files', extensions: ['mp4', 'avi', 'mov', 'mkv'] },
    ],
    properties: ['openFile'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const filePath = result.filePaths[0];
  const stats = fs.statSync(filePath);
  const name = path.basename(filePath);
  const buffer = await fs.promises.readFile(filePath);

  return {
    canceled: false,
    filePath,
    name,
    size: stats.size,
    buffer,
  };
});

ipcMain.handle('asteria:save-report-dialog', async (_event, { defaultFilename, data }) => {
  if (!mainWindow) return { success: false };
  const ext = path.extname(defaultFilename).replace('.', '');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save ASTERIA Mission Performance Report',
    defaultPath: defaultFilename,
    filters: [
      { name: `${ext.toUpperCase()} Report`, extensions: [ext || 'pdf'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true, success: false };
  }

  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    await fs.promises.writeFile(result.filePath, buf);
    log(`Report saved to ${result.filePath}`);
    return { success: true, filePath: result.filePath };
  } catch (err: any) {
    log(`Failed to save report: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('asteria:get-version', () => app.getVersion());

ipcMain.on('asteria:window-minimize', () => {
  mainWindow?.minimize();
});

ipcMain.on('asteria:window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});

ipcMain.on('asteria:window-close', () => {
  mainWindow?.close();
});

ipcMain.handle('asteria:window-is-maximized', () => {
  return mainWindow?.isMaximized() ?? false;
});

// ── Global Error Logging ──────────────────────────────────────
process.on('uncaughtException', (err) => {
  log(`[UNCAUGHT EXCEPTION] ${err?.stack || err}`);
});

process.on('unhandledRejection', (reason) => {
  log(`[UNHANDLED REJECTION] ${reason}`);
});

// ── App Lifecycle ─────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  log('Another instance is already running. Quitting duplicate instance.');
  app.quit();
} else {
  app.on('second-instance', () => {
    log('Second instance launched; focusing existing window.');
    if (mainWindow) {
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    stopProcesses();
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    stopProcesses();
  });

  process.on('exit', () => {
    stopProcesses();
  });
}
