import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import type { WsStatus } from '../../hooks/useSimulation';

interface NavItem {
  path: string;
  label: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { path: '/mission', label: 'Mission Control', icon: <IconMission /> },
  { path: '/tracking', label: 'Live Tracking', icon: <IconTracking /> },
  { path: '/detection', label: 'Detection', icon: <IconDetection /> },
  { path: '/camera', label: 'Camera Control', icon: <IconCamera /> },
  { path: '/disturbances', label: 'Disturbance Lab', icon: <IconDisturbance /> },
  { path: '/analytics', label: 'Analytics', icon: <IconAnalytics /> },
  { path: '/reports', label: 'Reports', icon: <IconReports /> },
  { path: '/settings', label: 'Settings', icon: <IconSettings /> },
];

interface Props {
  wsStatus: WsStatus;
  simStatus: string;
}

export function SideNav({ wsStatus, simStatus }: Props) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const wsColor = wsStatus === 'connected' ? '#4caf82' :
                  wsStatus === 'error'     ? '#c05050' : '#6b7f80';

  const simColor = simStatus === 'running' ? '#4caf82' :
                   simStatus === 'paused'  ? '#e0a040' : '#6b7f80';

  return (
    <nav className="sidenav">
      {/* Logo */}
      <div className="sidenav-logo">
        <LogoMark />
        <div className="sidenav-logo-text">
          <span className="sidenav-product">FSOC PAT</span>
          <span className="sidenav-sub">Virtual Tracking System</span>
        </div>
      </div>

      {/* Status bar */}
      <div className="sidenav-status-row">
        <div className="sidenav-status-dot" style={{ background: wsColor }} />
        <span className="sidenav-status-label">
          {wsStatus === 'connected' ? 'TELEMETRY LIVE' :
           wsStatus === 'error' ? 'CONN ERROR' : 'OFFLINE'}
        </span>
        <div className="sidenav-status-dot ml-auto" style={{ background: simColor }} />
        <span className="sidenav-status-label">{simStatus.toUpperCase()}</span>
      </div>

      <div className="sidenav-divider" />

      {/* Nav items */}
      <ul className="sidenav-list">
        {NAV_ITEMS.map(item => (
          <li key={item.path}>
            <NavLink
              to={item.path}
              className={({ isActive }) =>
                `sidenav-item${isActive ? ' sidenav-item--active' : ''}`
              }
            >
              <span className="sidenav-icon">{item.icon}</span>
              <span className="sidenav-label">{item.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="sidenav-spacer" />

      {/* Copilot */}
      <NavLink
        to="/copilot"
        className={({ isActive }) =>
          `sidenav-item sidenav-item--copilot${isActive ? ' sidenav-item--active' : ''}`
        }
      >
        <span className="sidenav-icon"><IconCopilot /></span>
        <span className="sidenav-label">Gemini Copilot</span>
        <span className="sidenav-badge">AI</span>
      </NavLink>

      <div className="sidenav-divider" />

      {/* User */}
      <div className="sidenav-user">
        {user?.photoURL ? (
          <img src={user.photoURL} alt="avatar" className="sidenav-avatar" />
        ) : (
          <div className="sidenav-avatar-fallback">
            {user?.displayName?.[0] ?? user?.email?.[0] ?? 'U'}
          </div>
        )}
        <div className="sidenav-user-info">
          <span className="sidenav-user-name">
            {user?.displayName ?? user?.email?.split('@')[0] ?? 'Operator'}
          </span>
          <button
            className="sidenav-logout"
            onClick={() => { logout().then(() => navigate('/login')); }}
          >
            Sign Out
          </button>
        </div>
      </div>
    </nav>
  );
}

// ── Icon components ───────────────────────────────────────────
function LogoMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r="14" stroke="#3ecfcf" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="8" stroke="#3ecfcf" strokeWidth="1" opacity="0.5" />
      <circle cx="16" cy="16" r="3" fill="#3ecfcf" />
      <line x1="16" y1="2" x2="16" y2="6" stroke="#3ecfcf" strokeWidth="1.5" />
      <line x1="16" y1="26" x2="16" y2="30" stroke="#3ecfcf" strokeWidth="1.5" />
      <line x1="2" y1="16" x2="6" y2="16" stroke="#3ecfcf" strokeWidth="1.5" />
      <line x1="26" y1="16" x2="30" y2="16" stroke="#3ecfcf" strokeWidth="1.5" />
    </svg>
  );
}
function IconMission()    { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M9 9h6M9 12h6M9 15h4"/></svg>; }
function IconTracking()   { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><line x1="12" y1="3" x2="12" y2="8"/><line x1="12" y1="16" x2="12" y2="21"/><line x1="3" y1="12" x2="8" y2="12"/><line x1="16" y1="12" x2="21" y2="12"/></svg>; }
function IconDetection()  { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 8V4h4M22 8V4h-4M2 16v4h4M22 16v4h-4"/><circle cx="12" cy="12" r="3"/></svg>; }
function IconCamera()     { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>; }
function IconDisturbance(){ return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 12h4l3-6 4 12 3-9 2 3h4"/></svg>; }
function IconAnalytics()  { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>; }
function IconReports()    { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>; }
function IconSettings()   { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>; }
function IconCopilot()    { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M22 2 12 12"/><circle cx="12" cy="12" r="3"/></svg>; }
