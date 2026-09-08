"""FSOC PAT — CSV Report Generator"""
import csv
import io
from database.models import get_run, get_telemetry


def generate_csv(run_id: str) -> str:
    """Return CSV string of telemetry samples for the given run."""
    samples = get_telemetry(run_id)
    if not samples:
        return 'No telemetry data found for run_id: ' + run_id

    output = io.StringIO()
    fieldnames = [
        'frame_id', 'elapsed', 'timestamp', 'target_state',
        'target_px_x', 'target_px_y', 'centroid_x', 'centroid_y',
        'pixel_error_x', 'pixel_error_y', 'pixel_error_total',
        'pan', 'tilt', 'pan_error', 'tilt_error', 'total_error',
        'confidence', 'fps', 'processing_ms', 'kalman_x', 'kalman_y',
        'disturbance_idx'
    ]
    writer = csv.DictWriter(output, fieldnames=fieldnames, extrasaction='ignore')
    writer.writeheader()
    writer.writerows(samples)
    return output.getvalue()
