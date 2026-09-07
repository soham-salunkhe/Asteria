/**
 * FSOC Virtual PAT — Node.js Backend
 * Sole responsibility: Gemini Engineering Copilot proxy.
 *
 * All simulation, tracking, WebSocket, and database operations
 * are handled by the Python FastAPI service (ai-service/fsoc_main.py).
 */
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { guideRouter } from './routes/guideRoutes.js';

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 5001;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Request logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ── Routes ────────────────────────────────────────────────────
// Gemini Engineering Copilot — used by the FSOC Copilot page
// Vite proxy forwards /api/guide → http://localhost:5001/api/guide
app.use('/api/guide', guideRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status:    'healthy',
    service:   'fsoc-pat-node-backend',
    version:   '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`🚀 FSOC PAT Node Backend running on http://localhost:${PORT}`);
});
