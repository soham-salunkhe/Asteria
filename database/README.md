# FSOC Virtual PAT — Database

The database for this project is **SQLite**, automatically created by the Python simulation service.

## Location

```
ai-service/fsoc_pat.db
```

## Created automatically

The database is initialised on first run by `ai-service/database/models.py`.
No manual setup is required.

## Schema

| Table | Purpose |
|-------|---------|
| `scenarios` | Saved simulation configurations |
| `simulation_runs` | Completed run records with performance summary |
| `telemetry_samples` | Sampled telemetry frames (every 5 frames) for reports |

## Reset

To reset the database, delete `ai-service/fsoc_pat.db` and restart the service.
