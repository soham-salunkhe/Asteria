/**
 * FSOC-PAT — Reusable retro terminal primitives.
 * Visual-only wrappers; no simulation logic lives here.
 */
import React from 'react';

export function TerminalPanel({
  index,
  title,
  right,
  children,
}: {
  index?: string;
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="tpanel">
      <header className="tpanel-head">
        {index && <span className="tpanel-idx">{index}</span>}
        <span>{title}</span>
        <span style={{ marginLeft: 'auto' }}>{right}</span>
      </header>
      <div className="tpanel-body">{children}</div>
    </section>
  );
}

export function TerminalButton({
  children,
  primary = false,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button className={`tbtn${primary ? ' tbtn--primary' : ''}`} {...rest}>
      {children}
    </button>
  );
}

export function TelemetryLabel({ children }: { children: React.ReactNode }) {
  return <div className="tlabel">{children}</div>;
}

export function TelemetryValue({ children }: { children: React.ReactNode }) {
  return <div className="tvalue">{children}</div>;
}

export function TechnicalDivider() {
  return <div className="tdiv" role="separator" />;
}

export function TerminalInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className="tinput" {...props} />;
}

export function StatusIndicator({ live, label }: { live: boolean; label: string }) {
  return (
    <span className={`tstatus${live ? ' tstatus--live' : ''}`}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

export function MissionNavItem({
  index,
  label,
  active = false,
  onClick,
}: {
  index: string;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={`mc-qnav-btn${active ? ' mc-btn-config--active' : ''}`}
      onClick={onClick}
    >
      <span style={{ opacity: 0.55, marginRight: 8 }}>{index}</span>
      {label} →
    </button>
  );
}
