"""
FSOC PAT — SQLite Database Models
Stores scenarios, simulation runs, and sampled telemetry.
"""
import sqlite3
import json
import time
import uuid
from pathlib import Path
from typing import Optional, Any

DB_PATH = Path(__file__).parent.parent / 'fsoc_pat.db'


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA synchronous=NORMAL')
    conn.execute('PRAGMA temp_store=MEMORY')
    conn.execute('PRAGMA foreign_keys=ON')
    return conn


def init_db() -> None:
    """Create tables if they don't exist."""
    conn = get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS scenarios (
            id           TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            description  TEXT,
            environment  TEXT NOT NULL,
            config_json  TEXT NOT NULL,
            created_at   REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS simulation_runs (
            run_id              TEXT PRIMARY KEY,
            scenario_id         TEXT,
            scenario_name       TEXT,
            environment         TEXT,
            started_at          REAL NOT NULL,
            ended_at            REAL,
            duration            REAL,
            acquisition_time    REAL,
            average_error       REAL,
            max_error           REAL,
            lock_retention      REAL,
            avg_fps             REAL,
            processing_ms       REAL,
            detection_confidence REAL,
            final_state         TEXT,
            status              TEXT DEFAULT 'running',
            FOREIGN KEY (scenario_id) REFERENCES scenarios(id)
        );

        CREATE TABLE IF NOT EXISTS telemetry_samples (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id          TEXT NOT NULL,
            timestamp       REAL NOT NULL,
            frame_id        INTEGER,
            elapsed         REAL,
            target_state    TEXT,
            pan             REAL,
            tilt            REAL,
            pan_error       REAL,
            tilt_error      REAL,
            total_error     REAL,
            confidence      REAL,
            fps             REAL,
            processing_ms   REAL,
            kalman_x        REAL,
            kalman_y        REAL,
            disturbance_idx REAL,
            FOREIGN KEY (run_id) REFERENCES simulation_runs(run_id)
        );

        CREATE INDEX IF NOT EXISTS idx_telemetry_run
            ON telemetry_samples(run_id);
        CREATE INDEX IF NOT EXISTS idx_runs_started
            ON simulation_runs(started_at DESC);
    """)
    # Ensure new PS4 performance columns exist
    for col in ('lost_count INTEGER', 'reacquisition_count INTEGER',
                'avg_reacquisition_time REAL', 'max_reacquisition_time REAL',
                'rmse_px REAL', 'average_error_px REAL', 'max_error_px REAL',
                'total_frames INTEGER', 'target_loss_pct REAL'):
        try:
            conn.execute(f"ALTER TABLE simulation_runs ADD COLUMN {col}")
        except Exception:
            pass
    # Ensure centroiding error columns exist in telemetry_samples
    for col in ('pixel_error_x REAL', 'pixel_error_y REAL', 'pixel_error_total REAL',
                'centroid_x REAL', 'centroid_y REAL', 'target_px_x REAL', 'target_px_y REAL'):
        try:
            conn.execute(f"ALTER TABLE telemetry_samples ADD COLUMN {col}")
        except Exception:
            pass
    conn.commit()
    conn.close()


# ── Scenarios ─────────────────────────────────────────────────

def save_scenario(config: dict) -> str:
    sid = config.get('id') or str(uuid.uuid4())
    conn = get_conn()
    conn.execute(
        """INSERT OR REPLACE INTO scenarios
           (id, name, description, environment, config_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (sid, config.get('name', 'Unnamed'), config.get('description', ''),
         config.get('environment', 'urban'), json.dumps(config), time.time())
    )
    conn.commit()
    conn.close()
    return sid


def list_scenarios() -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, name, description, environment, created_at FROM scenarios "
        "ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_scenario(sid: str) -> Optional[dict]:
    conn = get_conn()
    row = conn.execute(
        "SELECT config_json FROM scenarios WHERE id=?", (sid,)
    ).fetchone()
    conn.close()
    if row:
        return json.loads(row['config_json'])
    return None


# ── Simulation runs ───────────────────────────────────────────

def create_run(scenario_id: Optional[str], scenario_name: str, env: str) -> str:
    run_id = str(uuid.uuid4())
    conn = get_conn()
    conn.execute(
        """INSERT INTO simulation_runs
           (run_id, scenario_id, scenario_name, environment, started_at, status)
           VALUES (?, ?, ?, ?, ?, 'running')""",
        (run_id, scenario_id, scenario_name, env, time.time())
    )
    conn.commit()
    conn.close()
    return run_id


def complete_run(run_id: str, summary: dict, final_state: str, status: str = 'completed') -> None:
    conn = get_conn()
    now = time.time()
    conn.execute(
        """UPDATE simulation_runs SET
           ended_at=?, duration=?, acquisition_time=?, average_error=?,
           max_error=?, lock_retention=?, avg_fps=?, processing_ms=?,
           detection_confidence=?, final_state=?, status=?,
           lost_count=?, reacquisition_count=?,
           avg_reacquisition_time=?, max_reacquisition_time=?,
           rmse_px=?, average_error_px=?, max_error_px=?,
           total_frames=?, target_loss_pct=?
           WHERE run_id=?""",
        (now, summary.get('duration'), summary.get('acquisition_time'),
         summary.get('average_error'), summary.get('max_error'),
         summary.get('lock_retention'), summary.get('avg_fps'),
         summary.get('avg_processing_ms'), summary.get('detection_confidence'),
         final_state, status,
         summary.get('lost_count', 0), summary.get('reacquisition_count', 0),
         summary.get('avg_reacquisition_time'), summary.get('max_reacquisition_time'),
         summary.get('rmse_px'), summary.get('average_error_px'), summary.get('max_error_px'),
         summary.get('total_frames', 0), summary.get('target_loss_pct', 0.0),
         run_id)
    )
    conn.commit()
    conn.close()


def list_runs(limit: int = 50) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        """SELECT run_id, scenario_name, environment, started_at,
                  duration, acquisition_time, average_error, max_error,
                  average_error_px, max_error_px, rmse_px, target_loss_pct,
                  lock_retention, avg_fps, processing_ms,
                  detection_confidence, final_state, status,
                  lost_count, reacquisition_count,
                  avg_reacquisition_time, max_reacquisition_time, total_frames
           FROM simulation_runs
           ORDER BY started_at DESC LIMIT ?""",
        (limit,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_run(run_id: str) -> Optional[dict]:
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM simulation_runs WHERE run_id=?", (run_id,)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


# ── Telemetry samples ─────────────────────────────────────────

def save_telemetry_sample(run_id: str, frame: dict, frame_id: int) -> None:
    """Save a sampled telemetry frame (call at reduced rate, e.g. every 5 frames)."""
    cam = frame.get('camera', {})
    err = frame.get('angular_error', {})
    met = frame.get('metrics', {})
    kal = frame.get('kalman') or {}
    dis = frame.get('disturbance', {})
    c_err = frame.get('centroiding_error', {})
    kal_pos = kal.get('position', {}) if kal else {}

    conn = get_conn()
    conn.execute(
        """INSERT INTO telemetry_samples
           (run_id, timestamp, frame_id, elapsed, target_state,
            pan, tilt, pan_error, tilt_error, total_error,
            confidence, fps, processing_ms, kalman_x, kalman_y, disturbance_idx,
            pixel_error_x, pixel_error_y, pixel_error_total, centroid_x, centroid_y, target_px_x, target_px_y)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (run_id, frame.get('timestamp', time.time()), frame_id,
         frame.get('elapsed', 0),
         frame.get('target_state', 'UNKNOWN'),
         cam.get('pan', 0), cam.get('tilt', 0),
         err.get('pan_error', 0), err.get('tilt_error', 0), err.get('total_error', 0),
         met.get('detection_confidence', 0), met.get('fps', 0), met.get('processing_ms', 0),
         kal_pos.get('x', 0), kal_pos.get('y', 0),
         dis.get('total_disturbance_index', 0),
         c_err.get('pixel_error_x'), c_err.get('pixel_error_y'), c_err.get('pixel_error_total'),
         c_err.get('centroid_x'), c_err.get('centroid_y'),
         c_err.get('target_px_x'), c_err.get('target_px_y'))
    )
    conn.commit()
    conn.close()


def get_telemetry(run_id: str, limit: int = 5000) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        """SELECT * FROM telemetry_samples WHERE run_id=?
           ORDER BY frame_id ASC LIMIT ?""",
        (run_id, limit)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]
