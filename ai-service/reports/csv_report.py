"""ASTERIA — CSV Report Generator"""
import csv
import io
import math
from database.models import get_run, get_telemetry


def generate_csv(run_id: str) -> str:
    """Return CSV string of telemetry samples for the given run.

    Per-frame rows first (pixel_error_total column carries the tracking
    error each frame was measured with), then `#`-prefixed summary lines
    with TRACKING/LOCKED-gated AVG/MAX/RMSE in pixels.
    """
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

    vals = [s.get('pixel_error_total') for s in samples
            if s.get('target_state') in ('TRACKING', 'LOCKED')
            and s.get('pixel_error_total') is not None]
    if vals:
        n = len(vals)
        rmse = math.sqrt(sum(v * v for v in vals) / n) if n >= 2 else float('nan')
        output.write(f'# summary px: n={n} avg={sum(vals)/n:.3f} '
                     f'max={max(vals):.3f} rmse={rmse:.3f}\n')
    else:
        output.write('# summary px: no TRACKING/LOCKED samples\n')
    return output.getvalue()
