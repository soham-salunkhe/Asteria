/**
 * FSOC — Reports Page
 * Lists completed simulation runs and provides export links.
 */
import React, { useEffect, useState } from 'react';
import { fsocApi } from '../../services/fsocApi';

interface RunRecord {
  run_id: string;
  scenario_name: string;
  environment: string;
  started_at: number;
  duration: number;
  acquisition_time: number | null;
  average_error: number;
  max_error: number;
  lock_retention: number;
  avg_fps: number;
  final_state: string;
  status: string;
  lost_count?: number;
  reacquisition_count?: number;
  avg_reacquisition_time?: number | null;
  max_reacquisition_time?: number | null;
}

function ts(v: number) {
  return new Date(v * 1000).toLocaleString('en-GB', { hour12: false });
}

export function ReportsPage() {
  const [runs, setRuns]           = useState<RunRecord[]>([]);
  const [loading, setLoading]     = useState(true);
  const [selected, setSelected]   = useState<RunRecord | null>(null);
  const [error, setError]         = useState('');

  useEffect(() => {
    fsocApi.listRuns()
      .then((res) => {
        setRuns((res.data ?? []) as RunRecord[]);
        setLoading(false);
      })
      .catch(() => {
        setError('Could not load runs — is the simulation backend running?');
        setLoading(false);
      });
  }, []);

  const openReport = (run: RunRecord) => setSelected(run);

  return (
    <div className="page-reports">
      <div className="page-header">
        <h2 className="page-title">Reports</h2>
        <span className="page-subtitle">Simulation Run History &amp; Export</span>
      </div>

      <div className="reports-body">
        {/* ── Run list ──────────────────────────────────────── */}
        <div className="reports-list-col">
          <div className="reports-list-header">
            <span className="rl-col rl-col-date">STARTED</span>
            <span className="rl-col rl-col-name">SCENARIO</span>
            <span className="rl-col rl-col-dur">DUR</span>
            <span className="rl-col rl-col-err">AVG ERR</span>
            <span className="rl-col rl-col-lock">LOCK</span>
            <span className="rl-col rl-col-state">STATE</span>
          </div>

          {loading && <div className="reports-empty">Loading…</div>}
          {error && <div className="reports-error">{error}</div>}
          {!loading && !error && runs.length === 0 && (
            <div className="reports-empty">No completed runs yet. Start a simulation first.</div>
          )}

          {runs.map(run => (
            <button
              key={run.run_id}
              className={`rl-row${selected?.run_id === run.run_id ? ' rl-row--selected' : ''}`}
              onClick={() => openReport(run)}
            >
              <span className="rl-col rl-col-date">{ts(run.started_at)}</span>
              <span className="rl-col rl-col-name">{run.scenario_name ?? '—'}</span>
              <span className="rl-col rl-col-dur">{run.duration?.toFixed(1) ?? '—'} s</span>
              <span className="rl-col rl-col-err">{run.average_error?.toFixed(3) ?? '—'}°</span>
              <span className="rl-col rl-col-lock">{run.lock_retention?.toFixed(1) ?? '—'}%</span>
              <span className={`rl-col rl-col-state state-pill state-pill--${run.final_state?.toLowerCase() ?? 'unknown'}`}>
                {run.final_state ?? '—'}
              </span>
            </button>
          ))}
        </div>

        {/* ── Detail panel ──────────────────────────────────── */}
        <div className="reports-detail-col">
          {selected ? (
            <>
              <div className="rd-title">Run Detail</div>
              <div className="rd-id">{selected.run_id}</div>

              <div className="rd-grid">
                {[
                  ['Scenario',    selected.scenario_name ?? '—'],
                  ['Environment', selected.environment?.toUpperCase() ?? '—'],
                  ['Started',     ts(selected.started_at)],
                  ['Duration',    `${selected.duration?.toFixed(2) ?? '—'} s`],
                  ['Acq Time',    selected.acquisition_time != null
                                    ? `${selected.acquisition_time.toFixed(3)} s` : '—'],
                  ['Re-acq Time', selected.avg_reacquisition_time != null
                                    ? `${selected.avg_reacquisition_time.toFixed(3)} s` : '—'],
                  ['Lost / Reacq', `${selected.lost_count ?? 0} / ${selected.reacquisition_count ?? 0}`],
                  ['Avg Error',   `${selected.average_error?.toFixed(4) ?? '—'} °`],
                  ['Max Error',   `${selected.max_error?.toFixed(4) ?? '—'} °`],
                  ['Lock Ret.',   `${selected.lock_retention?.toFixed(2) ?? '—'} %`],
                  ['Avg FPS',     selected.avg_fps?.toFixed(1) ?? '—'],
                  ['Final State', selected.final_state ?? '—'],
                  ['Status',      selected.status?.toUpperCase() ?? '—'],
                ].map(([k, v]) => (
                  <div key={k} className="rd-row">
                    <span className="rd-key">{k}</span>
                    <span className="rd-val">{v}</span>
                  </div>
                ))}
              </div>

              <div className="rd-exports">
                <div className="rd-exports-title">EXPORT</div>
                {(['csv', 'json', 'pdf'] as const).map(fmt => (
                  <a
                    key={fmt}
                    href={fsocApi.reportUrl(selected.run_id, fmt)}
                    download
                    className="rd-export-btn"
                    target="_blank"
                    rel="noreferrer"
                  >
                    ↓ {fmt.toUpperCase()}
                  </a>
                ))}
              </div>
            </>
          ) : (
            <div className="rd-placeholder">Select a run to view details and export.</div>
          )}
        </div>
      </div>
    </div>
  );
}
