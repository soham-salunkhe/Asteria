"""FSOC PAT — JSON Report Generator"""
import json
from database.models import get_run, get_telemetry


def generate_json(run_id: str) -> str:
    """Return JSON string of run summary + telemetry samples."""
    run = get_run(run_id)
    if not run:
        return json.dumps({'error': f'Run {run_id} not found'})

    samples = get_telemetry(run_id, limit=2000)  # cap for JSON size
    result = {
        'run': run,
        'telemetry_sample_count': len(samples),
        'telemetry': samples,
    }
    return json.dumps(result, indent=2, default=str)
