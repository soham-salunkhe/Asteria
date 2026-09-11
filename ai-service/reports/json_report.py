"""ASTERIA — JSON Report Generator"""
import json
import math
from database.models import get_run, get_telemetry


def _tracking_px_stats(samples: list[dict]) -> dict:
    """TRACKING/LOCKED-gated pixel stats from telemetry samples.

    Same population the live metrics use — measured values only.
    """
    vals = [s.get('pixel_error_total') for s in samples
            if s.get('target_state') in ('TRACKING', 'LOCKED')
            and s.get('pixel_error_total') is not None]
    n = len(vals)
    if not n:
        return {'average_error_px': None, 'max_error_px': None,
                'rmse_px': None, 'tracking_samples': 0}
    rmse = math.sqrt(sum(v * v for v in vals) / n) if n >= 2 else None
    return {'average_error_px': round(sum(vals) / n, 3),
            'max_error_px': round(max(vals), 3),
            'rmse_px': round(rmse, 3) if rmse is not None else None,
            'tracking_samples': n}


def generate_json(run_id: str) -> str:
    """Return JSON string of run summary + telemetry samples."""
    run = get_run(run_id)
    if not run:
        return json.dumps({'error': f'Run {run_id} not found'})

    samples = get_telemetry(run_id, limit=2000)  # cap for JSON size
    result = {
        'run': run,
        'pixel_stats': _tracking_px_stats(samples),
        'telemetry_sample_count': len(samples),
        'telemetry': samples,
    }
    return json.dumps(result, indent=2, default=str)
