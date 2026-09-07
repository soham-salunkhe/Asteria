@echo off
title MICHIRA / FSOC Virtual PAT Launcher
echo ===================================================
echo   Starting MICHIRA / FSOC Virtual PAT Simulation
echo ===================================================
echo.

set ROOT_DIR=%~dp0

echo [1/3] Starting Python Simulation Engine (fsoc_main:app) on http://localhost:8000...
start "FSOC Python Engine (Port 8000)" cmd /k "cd /d %ROOT_DIR%ai-service && python -m uvicorn fsoc_main:app --host 127.0.0.1 --port 8000"

echo [2/3] Starting Backend API on http://localhost:5001...
start "Backend API (Port 5001)" cmd /k "cd /d %ROOT_DIR%backend && npm run dev"

echo [3/3] Starting Frontend App on http://localhost:5173...
start "Frontend (Port 5173)" cmd /k "cd /d %ROOT_DIR%frontend && npm run dev"

echo.
echo All services launched in separate windows!
echo - Frontend:   http://localhost:5173
echo - Simulation: http://localhost:8000/docs
echo - Backend:    http://localhost:5001
echo.
