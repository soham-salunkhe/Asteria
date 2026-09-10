/**
 * FSOC·TRACK — Application Root
 * Landing page at "/" (public, no auth required).
 * Virtual environment at "/mission", "/tracking", etc. (LOGIN REQUIRED).
 * Users CANNOT access the virtual environment before logging in.
 */
import React from 'react';
import {
  BrowserRouter as Router,
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

// ── Auth guard ────────────────────────────────────────────────
// Redirects unauthenticated users to /login with ?redirect=
// so they return to the intended page after signing in.

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isLoggedIn, authLoading } = useAuth();
  if (authLoading) return <div className="fsoc-loading">Authenticating…</div>;
  if (!isLoggedIn) {
    const redirect = window.location.pathname + window.location.search;
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

      {/* ── Auth pages (no sidebar) ─────────────────────────── */}
      <Route path="/login"         element={<LoginPage />} />
      <Route path="/signup"        element={<SignUpPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      {/* ── Protected virtual environment (LOGIN REQUIRED) ──── */}
      <Route
        path="/*"
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      />
    </Routes>
  );
}

export function App() {
  return (
    <AuthProvider>
      <SimulationProvider>
        <Router>
          <AppRoutes />
        </Router>
      </SimulationProvider>
    </AuthProvider>
  );
}

export default App;
