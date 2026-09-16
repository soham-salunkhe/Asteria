/**
 * FSOC·TRACK — Application Root
 * Landing page at "/" (public, no auth required).
 * Virtual environment at "/mission", "/tracking", etc. (LOGIN REQUIRED).
 * Users CANNOT access the virtual environment before logging in.
 */
import React from 'react';
import {
  BrowserRouter,
  HashRouter,
  Routes,
  Route,
  Navigate,
} from 'react-router-dom';
import { AuthProvider }       from './context/AuthContext';
import { useAuth }            from './context/AuthContext';
import { SimulationProvider, useSimulation } from './hooks/useSimulation';
import { SideNav }            from './components/layout/SideNav';
import { LandingPage }        from './pages/LandingPage';
import { LoginPage }          from './pages/LoginPage';
import { SignUpPage }         from './pages/SignUpPage';
import { ResetPasswordPage }  from './pages/ResetPasswordPage';
import { MissionControlPage } from './pages/MissionControl/MissionControlPage';
import { LiveTrackingPage }   from './pages/LiveTracking/LiveTrackingPage';
import { DetectionPage }      from './pages/Detection/DetectionPage';
import { CameraControlPage }  from './pages/CameraControl/CameraControlPage';
import { DisturbancesPage }   from './pages/Disturbances/DisturbancesPage';
import { AnalyticsPage }      from './pages/Analytics/AnalyticsPage';
import { ReportsPage }        from './pages/Reports/ReportsPage';
import { SettingsPage }       from './pages/Settings/SettingsPage';
import { CopilotPage }        from './pages/Copilot/CopilotPage';

// ── Router Selector ───────────────────────────────────────────
// Electron uses file:// protocol where HashRouter avoids pathname collision.
const isDesktopApp = typeof window !== 'undefined' && (
  window.location.protocol === 'file:' ||
  !!(window as any).asteriaDesktop
);
const AppRouter = isDesktopApp ? HashRouter : BrowserRouter;

// ── Route config ──────────────────────────────────────────────
// Show landing page for all users (desktop and web)
const skipLanding = false;

// ── Auth guard ────────────────────────────────────────────────
// Redirects unauthenticated users to /login with ?redirect=
// so they return to the intended page after signing in.

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isLoggedIn, authLoading } = useAuth();
  if (authLoading) return <div className="fsoc-loading">Authenticating…</div>;
  if (!isLoggedIn) {
    const rawRedirect = window.location.hash
      ? window.location.hash.replace(/^#/, '')
      : window.location.pathname;
    const redirect = (rawRedirect && !rawRedirect.includes(':') && !rawRedirect.includes('.html'))
      ? rawRedirect
      : '/mission';
    return <Navigate to={`/login?redirect=${encodeURIComponent(redirect)}`} replace />;
  }
  return <>{children}</>;
}

// ── App shell (authenticated layout) ─────────────────────────

function AppShell() {
  const sim = useSimulation();

  return (
    <div className="fsoc-shell">
      <SideNav wsStatus={sim.wsStatus} simStatus={sim.simStatus} />
      <main className="fsoc-main">
        <Routes>
          <Route path="/"             element={<Navigate to="/mission" replace />} />
          <Route path="/mission"      element={<MissionControlPage />} />
          <Route path="/tracking"     element={<LiveTrackingPage />} />
          <Route path="/detection"    element={<DetectionPage />} />
          <Route path="/camera"       element={<CameraControlPage />} />
          <Route path="/disturbances" element={<DisturbancesPage />} />
          <Route path="/analytics"    element={<AnalyticsPage />} />
          <Route path="/reports"      element={<ReportsPage />} />
          <Route path="/settings"     element={<SettingsPage />} />
          <Route path="/copilot"      element={<CopilotPage />} />
          <Route path="*"             element={<Navigate to="/mission" replace />} />
        </Routes>
      </main>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────

function AppRoutes() {
  return (
    <Routes>
      {/* ── Public landing page ─────────────────────────────── */}
      <Route path="/"              element={<LandingPage />} />

      {/* ── Auth pages (no sidebar) - keeping for future use ─── */}
      <Route path="/login"         element={<LoginPage />} />
      <Route path="/signup"        element={<SignUpPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      {/* ── Virtual environment (Demo mode - no auth required) ── */}
      <Route path="/*" element={<AppShell />} />
    </Routes>
  );
}

export function App() {
  return (
    <AuthProvider>
      <SimulationProvider>
        <AppRouter>
          <AppRoutes />
        </AppRouter>
      </SimulationProvider>
    </AuthProvider>
  );
}

export default App;
