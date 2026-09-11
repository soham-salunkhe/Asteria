#!/bin/bash
# ASTERIA Multi-Service Launcher

echo "🛰️  Starting ASTERIA — AI-Based Virtual Camera Tracking..."
echo "=========================================================="

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 1. Start Python FastAPI AI Engine / Simulation Engine
echo "🧠 [1/3] Starting Python Simulation Engine on http://localhost:8000..."
cd "$ROOT_DIR/ai-service"
python -m uvicorn fsoc_main:app --host 127.0.0.1 --port 8000 &
AI_PID=$!

# 2. Start Node.js Express Backend
echo "🚀 [2/3] Starting Backend API on http://localhost:5001..."
cd "$ROOT_DIR/backend"
npx tsx src/index.ts &
BACKEND_PID=$!

# 3. Start React Vite Frontend
echo "💻 [3/3] Starting React Frontend on http://localhost:5173..."
cd "$ROOT_DIR/frontend"
npx vite --port 5173 --host &
FRONTEND_PID=$!

trap "echo 'Stopping all services...'; kill $AI_PID $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT TERM

echo ""
echo "✨ ASTERIA is live!"
echo "👉 Frontend App:       http://localhost:5173"
echo "👉 Backend API:        http://localhost:5001"
echo "👉 AI Engine Docs:     http://localhost:8000/docs"
echo ""

wait
