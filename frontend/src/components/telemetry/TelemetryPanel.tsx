/**
 * FSOC — Telemetry Panel
 * Renders a block of monospace key-value telemetry fields.
 * Values update from live simulation state — nothing is hardcoded.
 */
import React from 'react';

export interface TelemetryField {
  label: string;
  value: string | number | null | undefined;
  unit?: string;
  highlight?: boolean;
  warn?: boolean;
  dim?: boolean;
}

interface Props {
  title?: string;
  fields: TelemetryField[];
  columns?: 1 | 2;
  compact?: boolean;
}

export function TelemetryPanel({ title, fields, columns = 1, compact = false }: Props) {
  return (
    <div className={`tel-panel${compact ? ' tel-panel--compact' : ''}`}>
      {title && <div className="tel-panel-title">{title}</div>}
      <div className={`tel-panel-grid tel-panel-grid--${columns}col`}>
        {fields.map((f, i) => (
          <TelemetryRow key={i} field={f} />
        ))}
      </div>
    </div>
  );
}

function TelemetryRow({ field }: { field: TelemetryField }) {
  const cls = field.highlight ? 'tel-value tel-value--highlight'
            : field.warn      ? 'tel-value tel-value--warn'
            : field.dim       ? 'tel-value tel-value--dim'
            : 'tel-value';

  const display = field.value === null || field.value === undefined
    ? '—'
    : field.unit
    ? `${field.value} ${field.unit}`
    : String(field.value);

  return (
    <div className="tel-row">
      <span className="tel-label">{field.label}</span>
      <span className={cls}>{display}</span>
    </div>
  );
}
