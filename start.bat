@echo off
title ASTERIA / FSOC Virtual PAT Launcher
echo ===================================================
echo   Starting ASTERIA / FSOC Virtual PAT Simulation
echo ===================================================
echo.

set ROOT_DIR=%~dp0

echo [1/3] Starting Python Simulation Engine (Port 8000)...
start "ASTERIA Python Engine (Port 8000)" cmd /k "cd /d %ROOT_DIR%ai-service && python -m uvicorn fsoc_main:app --host 127.0.0.1 --port 8000"

echo [2/3] Starting Node Backend Copilot Proxy (Port 5001)...
start "ASTERIA Node Backend (Port 5001)" cmd /k "cd /d %ROOT_DIR%backend && npm run dev"

echo [3/3] Starting Frontend Web App (Port 5173)...
start "ASTERIA Frontend (Port 5173)" cmd /k "cd /d %ROOT_DIR%frontend && npm run dev"

echo.
echo ===================================================
echo All services launched in separate windows!
echo - Frontend:   http://localhost:5173
echo - Simulation: http://localhost:8000/docs
echo - Backend:    http://localhost:5001
echo ===================================================
echo.
