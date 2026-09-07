/**
 * FSOC Virtual PAT — Application Root
 * Preserves Firebase/AuthContext from MICHIRA.
 * New FSOC routing with sidebar layout.
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
import { useSimulation }      from './hooks/useSimulation';
import { SideNav }            from './components/layout/SideNav';
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

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isLoggedIn, authLoading } = useAuth();
  if (authLoading) return <div className="fsoc-loading">Authenticating…</div>;
  if (!isLoggedIn) return <Navigate to="/login" replace />;
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
      {/* Auth pages — no sidebar */}
      <Route path="/login"          element={<LoginPage />} />
      <Route path="/signup"         element={<SignUpPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      {/* Authenticated shell */}
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
      <Router>
        <AppRoutes />
      </Router>
    </AuthProvider>
  );
}

export default App;
