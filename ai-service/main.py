"""
FSOC Virtual PAT — AI Service entry point.
The full application is defined in fsoc_main.py.

Run with:
    python -m uvicorn fsoc_main:app --reload --port 8000
"""
# This file is kept for IDE / tooling discovery only.
# All routes, WebSocket, and simulation logic live in fsoc_main.py.
from fsoc_main import app  # noqa: F401
