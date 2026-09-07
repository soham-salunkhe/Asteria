import { useState, useCallback, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  signInWithEmailAndPassword,
  signInWithPopup,
  sendPasswordResetEmail,
  getAdditionalUserInfo,
  deleteUser,
} from 'firebase/auth';
import { auth, googleProvider } from '../firebase/firebase';
import { getAuthErrorMessage } from '../firebase/authErrors';
import { useAuth } from '../context/AuthContext';
import './LoginPage.css';
import './SignUpPage.css'; // reuse all .su-* utility classes

// ─── Types ────────────────────────────────────────────────────────────────────

interface LoginFields {
  email: string;
  password: string;
  remember: boolean;
}

interface LoginErrors {
  email?: string;
  password?: string;
  form?: string; // generic server-level error
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateEmail(v: string): string | undefined {
  const t = v.trim().toLowerCase();
  if (!t) return 'Please enter your email address.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t)) return 'Please enter a valid email address.';
  return undefined;
}

function validatePassword(v: string): string | undefined {
  if (!v) return 'Please enter your password.';
  if (v.length < 6) return 'Password must be at least 6 characters.';
  return undefined;
}

// ─── SVG atoms (shared motifs) ────────────────────────────────────────────────

const BrandLogo = () => (
  <svg viewBox="0 0 40 40" fill="none" width={30} height={30} aria-hidden="true">
    <path d="M20 3 L27 13 L27 16 L13 16 L13 13 Z" fill="#B99550" />
    <rect x="15" y="16" width="10" height="16" fill="none" stroke="#B99550" strokeWidth="1" />
    <path d="M11 32 H29 V36 H11 Z" fill="#B99550" opacity="0.9" />
    <circle cx="20" cy="9" r="1.4" fill="#0B0D0D" />
  </svg>
);

const CornerOrn = () => (
  <svg viewBox="0 0 22 22" fill="none" aria-hidden="true">
    <path d="M2 20 L2 2 L20 2" stroke="#B99550" strokeWidth="1" fill="none" />
    <path d="M2 2 L6 6" stroke="#B99550" strokeWidth="0.8" />
    <circle cx="2" cy="2" r="1.2" fill="#B99550" />
    <circle cx="20" cy="2" r="0.8" fill="#B99550" opacity="0.5" />
    <circle cx="2" cy="20" r="0.8" fill="#B99550" opacity="0.5" />
  </svg>
);

const OrnamentCenter = () => (
  <svg viewBox="0 0 20 20" fill="none" width={16} height={16} aria-hidden="true">
    <circle cx="10" cy="10" r="4" stroke="#B99550" strokeWidth="0.8" />
    <circle cx="10" cy="10" r="1.5" fill="#B99550" opacity="0.6" />
    {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
      const rad = (deg * Math.PI) / 180;
      const x1 = 10 + 4 * Math.cos(rad);
      const y1 = 10 + 4 * Math.sin(rad);
      const x2 = 10 + 7 * Math.cos(rad);
      const y2 = 10 + 7 * Math.sin(rad);
      return <line key={deg} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#B99550" strokeWidth="0.7" opacity="0.55" />;
    })}
  </svg>
);

const GoogleIcon = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
  </svg>
);

const EyeIcon = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EyeOffIcon = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
    <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

const MailIcon = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="M2 7l10 7 10-7" />
  </svg>
);

const LockIcon = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0110 0v4" />
  </svg>
);

const ErrorDotIcon = () => (
  <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);

const ArrowLeftIcon = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </svg>
);

const TempleSilhouette = () => (
  <svg viewBox="0 0 900 80" preserveAspectRatio="none" aria-hidden="true">
    <path
      d="M0 80 L0 55 L50 55 L50 38 L75 38 L75 22 L100 8  L125 22 L125 38 L160 38 L160 55
         L210 55 L210 32 L230 32 L230 18 L248 4  L266 18 L266 32 L286 32 L286 55
         L380 55 L380 38 L405 38 L405 25 L425 12 L445 25 L445 38 L470 38 L470 55
         L540 55 L540 42 L562 42 L562 28 L580 14 L598 28 L598 42 L620 42 L620 55
         L680 55 L680 40 L700 40 L700 26 L715 14 L730 26 L730 40 L755 40 L755 55
         L830 55 L830 45 L850 45 L850 55 L900 55 L900 80 Z"
      fill="var(--gold)"
      opacity="0.55"
    />
  </svg>
);

// ─── Main component ───────────────────────────────────────────────────────────

export const LoginPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isLoggedIn, setPersistenceMode } = useAuth();
  const redirectTo = searchParams.get('redirect') || '/mission';

  // Already logged in — bounce straight to destination
  useEffect(() => {
    if (isLoggedIn) navigate(redirectTo, { replace: true });
  }, [isLoggedIn, navigate, redirectTo]);

  // Main form state
  const [form, setForm]       = useState<LoginFields>({ email: '', password: '', remember: false });
  const [errors, setErrors]   = useState<LoginErrors>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [showPw, setShowPw]   = useState(false);
  const [loading, setLoading] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);

  // Forgot-password flow
  const [forgotMode, setForgotMode]       = useState(false);
  const [forgotEmail, setForgotEmail]     = useState('');
  const [forgotError, setForgotError]     = useState('');
  const [forgotSent, setForgotSent]       = useState(false);
  const [forgotLoading, setForgotLoading] = useState(false);

  // Live validate touched fields
  useEffect(() => {
    const next: LoginErrors = {};
    if (touched.email)    next.email    = validateEmail(form.email);
    if (touched.password) next.password = validatePassword(form.password);
    setErrors(prev => ({ ...prev, ...next, form: touched.email || touched.password ? undefined : prev.form }));
  }, [form, touched]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    setForm(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  }, []);

  const handleBlur = useCallback((name: string) => {
    setTouched(prev => ({ ...prev, [name]: true }));
  }, []);

  const isFormValid = () => !validateEmail(form.email) && !validatePassword(form.password);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched({ email: true, password: true });

    if (!isFormValid()) return;

    setLoading(true);
    setErrors(prev => ({ ...prev, form: undefined }));

    /**
     * AUTH INTEGRATION POINT — replaced with Firebase below
     */
    try {
      // Honour "remember me": local persistence = survives browser close,
      // session persistence = clears when tab is closed.
      await setPersistenceMode(form.remember);

      await signInWithEmailAndPassword(
        auth,
        form.email.trim().toLowerCase(),
        form.password,
      );

      // onAuthStateChanged fires automatically — no manual login() call needed
      setLoading(false);
      setLoggedIn(true);
      setTimeout(() => navigate(redirectTo), 2500);
    } catch (err) {
      setErrors(prev => ({ ...prev, form: getAuthErrorMessage(err) }));
      setLoading(false);
    }
  };

  // Forgot password submit
  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validateEmail(forgotEmail);
    if (err) { setForgotError(err); return; }

    setForgotLoading(true);
    setForgotError('');

    try {
      await sendPasswordResetEmail(auth, forgotEmail.trim().toLowerCase());
      setForgotLoading(false);
      setForgotSent(true);
    } catch (err) {
      setForgotError(getAuthErrorMessage(err));
      setForgotLoading(false);
    }
  };

  // ── input class helper (same logic as SignUpPage) ──
  const inputCls = (name: keyof LoginErrors, extra = '') => {
    const hasErr = touched[name] && errors[name];
    const isOk   = touched[name] && !errors[name] && form[name as keyof LoginFields];
    return `su-input${hasErr ? ' error' : isOk ? ' success' : ''} ${extra}`.trim();
  };

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="login-root">

      {/* ── Fixed background — Taj Mahal ── */}
      <div className="login-bg" aria-hidden="true">
        <img
          src="/taj-mahal-hd.jpg"
          alt=""
          className="login-bg-img"
        />
        <div className="login-bg-scrim" />
        <div className="login-bg-glow" />
      </div>

      <div className="login-layout">

        {/* ════════════════════════════════════════
            LEFT — form card
            ════════════════════════════════════════ */}
        <div className="login-left">
          <div className="signup-card" role="main">

            {/* Corner ornaments */}
            <span className="su-corner su-corner-tl"><CornerOrn /></span>
            <span className="su-corner su-corner-tr"><CornerOrn /></span>
            <span className="su-corner su-corner-bl"><CornerOrn /></span>
            <span className="su-corner su-corner-br"><CornerOrn /></span>

            {/* ── SUCCESS STATE ──────────────────────── */}
            {loggedIn ? (
              <div className="su-success" role="status" aria-live="polite">
                <div className="su-success-icon" aria-hidden="true">
                  <svg viewBox="0 0 48 48" width={32} height={32} fill="none">
                    {/* Stylised key / unlock motif */}
                    <circle cx="20" cy="18" r="9" stroke="#D2A95D" strokeWidth="2" fill="none" />
                    <circle cx="20" cy="18" r="4" fill="#D2A95D" opacity="0.7" />
                    <path d="M29 27 L40 38" stroke="#D2A95D" strokeWidth="2.5" strokeLinecap="round" />
                    <path d="M36 34 L36 40 L40 40" stroke="#D2A95D" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>

                <div className="su-ornament" aria-hidden="true">
                  <span className="su-ornament-line" />
                  <OrnamentCenter />
                  <span className="su-ornament-line right" />
                </div>

                <p className="signup-card-eyebrow">Welcome back</p>
                <h2 className="su-success-title">You're signed in.</h2>
                <p className="su-success-sub">
                  Access to Mission Control restored.<br />
                  Your simulation workstation is ready.
                </p>
                <p className="su-success-redirect" aria-live="polite">
                  <span
                    style={{
                      display: 'inline-block',
                      width: 12,
                      height: 12,
                      border: '1.5px solid rgba(180,148,80,0.4)',
                      borderTopColor: 'var(--gold)',
                      borderRadius: '50%',
                      animation: 'suSpin 0.8s linear infinite',
                    }}
                    aria-hidden="true"
                  />
                  Returning to your journey…
                </p>
              </div>

            ) : forgotMode ? (
              /* ── FORGOT PASSWORD PANEL ─────────────── */
              <div className="login-forgot-panel">
                <button
                  type="button"
                  className="login-back-btn"
                  onClick={() => { setForgotMode(false); setForgotSent(false); setForgotError(''); setForgotEmail(''); }}
                  aria-label="Back to login"
                >
                  <ArrowLeftIcon /> Back to login
                </button>

                {forgotSent ? (
                  <div className="su-success" role="status" aria-live="polite">
                    <div className="su-success-icon" aria-hidden="true">
                      <svg viewBox="0 0 48 48" width={28} height={28} fill="none">
                        <rect x="4" y="10" width="40" height="28" rx="4" stroke="#D2A95D" strokeWidth="2" fill="none" />
                        <path d="M4 14 L24 28 L44 14" stroke="#D2A95D" strokeWidth="2" fill="none" />
                      </svg>
                    </div>
                    <p className="signup-card-eyebrow">Check your inbox</p>
                    <h2 className="su-success-title">Reset link sent.</h2>
                    <p className="su-success-sub">
                      We've sent a password reset link to<br />
                      <strong style={{ color: 'var(--gold-2)' }}>{forgotEmail}</strong>
                    </p>
                    <p style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 0 }}>
                      Didn't receive it?{' '}
                      <button
                        type="button"
                        style={{ background: 'none', border: 'none', color: 'var(--gold-2)', cursor: 'pointer', fontSize: 12, padding: 0 }}
                        onClick={() => setForgotSent(false)}
                      >
                        Try again
                      </button>
                    </p>
                  </div>
                ) : (
                  <>
                    <p className="signup-card-eyebrow">Password reset</p>
                    <h2 className="signup-card-title">Forgot your password?</h2>
                    <p className="signup-card-sub">
                      Enter your email and we'll send you a reset link.
                    </p>

                    <div className="su-ornament" aria-hidden="true">
                      <span className="su-ornament-line" />
                      <OrnamentCenter />
                      <span className="su-ornament-line right" />
                    </div>

                    <form onSubmit={handleForgotSubmit} noValidate aria-label="Forgot password form">
                      <div className="su-field">
                        <label htmlFor="forgot-email">Email Address</label>
                        <div className="su-input-wrap">
                          <span className="su-input-icon"><MailIcon /></span>
                          <input
                            id="forgot-email"
                            type="email"
                            autoComplete="email"
                            placeholder="your@email.com"
                            value={forgotEmail}
                            onChange={e => { setForgotEmail(e.target.value); setForgotError(''); }}
                            className={`su-input${forgotError ? ' error' : ''}`}
                            aria-invalid={!!forgotError}
                            aria-describedby="forgot-err"
                          />
                        </div>
                        <span
                          id="forgot-err"
                          className={`su-error${forgotError ? ' visible' : ''}`}
                          role="alert"
                        >
                          {forgotError && <><ErrorDotIcon /> {forgotError}</>}
                        </span>
                      </div>

                      <button type="submit" className="su-submit" disabled={forgotLoading} aria-busy={forgotLoading}>
                        {forgotLoading
                          ? <><span className="su-spinner" aria-hidden="true" /> Sending reset link…</>
                          : 'Send Reset Link'}
                      </button>
                    </form>
                  </>
                )}
              </div>

            ) : (
              /* ── LOGIN FORM ────────────────────────── */
              <>
                <p className="signup-card-eyebrow">Welcome back</p>
                <h2 className="signup-card-title">Sign in to FSOC PAT</h2>
                <p className="signup-card-sub">Access your simulation workstation.</p>

                <div className="su-ornament" aria-hidden="true">
                  <span className="su-ornament-line" />
                  <OrnamentCenter />
                  <span className="su-ornament-line right" />
                </div>

                {/* Generic form-level error */}
                {errors.form && (
                  <div
                    className="su-error visible"
                    role="alert"
                    aria-live="polite"
                    style={{ justifyContent: 'center', marginBottom: 16, fontSize: 13 }}
                  >
                    <ErrorDotIcon /> {errors.form}
                  </div>
                )}

                <form
                  className="su-form"
                  onSubmit={handleSubmit}
                  noValidate
                  aria-label="Login form"
                >
                  {/* ── Email ── */}
                  <div className="su-field">
                    <label htmlFor="login-email">Email Address</label>
                    <div className="su-input-wrap">
                      <span className="su-input-icon"><MailIcon /></span>
                      <input
                        id="login-email"
                        name="email"
                        type="email"
                        autoComplete="email"
                        placeholder="your@email.com"
                        value={form.email}
                        onChange={handleChange}
                        onBlur={() => handleBlur('email')}
                        className={inputCls('email')}
                        aria-invalid={!!(touched.email && errors.email)}
                        aria-describedby="login-email-err"
                      />
                    </div>
                    <span
                      id="login-email-err"
                      className={`su-error${touched.email && errors.email ? ' visible' : ''}`}
                      role="alert"
                    >
                      {errors.email && <><ErrorDotIcon /> {errors.email}</>}
                    </span>
                  </div>

                  {/* ── Password ── */}
                  <div className="su-field">
                    <label htmlFor="login-password">Password</label>
                    <div className="su-input-wrap">
                      <span className="su-input-icon"><LockIcon /></span>
                      <input
                        id="login-password"
                        name="password"
                        type={showPw ? 'text' : 'password'}
                        autoComplete="current-password"
                        placeholder="Enter your password"
                        value={form.password}
                        onChange={handleChange}
                        onBlur={() => handleBlur('password')}
                        className={inputCls('password', 'has-toggle')}
                        aria-invalid={!!(touched.password && errors.password)}
                        aria-describedby="login-pw-err"
                      />
                      <button
                        type="button"
                        className="su-pw-toggle"
                        onClick={() => setShowPw(s => !s)}
                        aria-label={showPw ? 'Hide password' : 'Show password'}
                      >
                        {showPw ? <EyeOffIcon /> : <EyeIcon />}
                      </button>
                    </div>
                    <span
                      id="login-pw-err"
                      className={`su-error${touched.password && errors.password ? ' visible' : ''}`}
                      role="alert"
                    >
                      {errors.password && <><ErrorDotIcon /> {errors.password}</>}
                    </span>
                  </div>

                  {/* ── Remember + Forgot ── */}
                  <div className="su-remember-row">
                    <label className="su-remember">
                      <input
                        type="checkbox"
                        name="remember"
                        checked={form.remember}
                        onChange={handleChange}
                        aria-label="Remember me"
                      />
                      Remember me
                    </label>
                    <button
                      type="button"
                      className="su-forgot"
                      onClick={() => setForgotMode(true)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, font: 'inherit' }}
                    >
                      Forgot password?
                    </button>
                  </div>

                  {/* ── Submit ── */}
                  <button
                    type="submit"
                    className="su-submit"
                    disabled={loading}
                    aria-busy={loading}
                  >
                    {loading
                      ? <><span className="su-spinner" aria-hidden="true" /> Signing you in…</>
                      : 'Sign In ✦'}
                  </button>

                  {/* ── Social ── */}
                  <div className="su-divider" aria-hidden="true">
                    <span className="su-divider-line" />
                    <span>or continue with</span>
                    <span className="su-divider-line" />
                  </div>

                  <div className="su-social">
                    <button
                      type="button"
                      className="su-social-btn"
                      aria-label="Continue with Google"
                      onClick={async () => {
                        setLoading(true);
                        setErrors(prev => ({ ...prev, form: undefined }));
                        try {
                          const result = await signInWithPopup(auth, googleProvider);
                          const info = getAdditionalUserInfo(result);
                          // Block sign-up via Google on the login page
                          if (info?.isNewUser) {
                            // Delete the freshly-created account and reject
                            await deleteUser(result.user);
                            setErrors(prev => ({
                              ...prev,
                              form: 'No account found with this Google address. Please sign up first.',
                            }));
                            setLoading(false);
                            return;
                          }
                          setLoading(false);
                          setLoggedIn(true);
                          setTimeout(() => navigate(redirectTo), 2500);
                        } catch (err) {
                          setErrors(prev => ({ ...prev, form: getAuthErrorMessage(err) }));
                          setLoading(false);
                        }
                      }}
                    >
                      <GoogleIcon />
                      Google
                    </button>
                  </div>

                  {/* ── Signup link ── */}
                  <p className="su-signup-row">
                    Don't have an account?
                    <Link to="/signup">Create one</Link>
                  </p>
                </form>
              </>
            )}
          </div>
        </div>

        {/* ════════════════════════════════════════
            RIGHT — branding copy
            ════════════════════════════════════════ */}
        <div className="login-right">

          <Link to="/" className="login-brand-row" aria-label="FSOC PAT home">
            <BrandLogo />
            <span className="login-brand-name">FSOC PAT</span>
          </Link>

          <div className="login-right-eyebrow">
            <span className="ey-line" />
            India · Heritage · Discovery
          </div>

          <h2 className="login-right-headline">
            See.<br />
            Acquire.<br />
            <em>Track.</em>
          </h2>

          <p className="login-right-sub">
            FSOC Virtual PAT simulates the complete coarse alignment and
            tracking pipeline — AI detection, Kalman prediction, PID control,
            and real-time performance analysis.
          </p>

          <div className="login-quote">
            <p className="login-quote-text">
              "Precision pointing is not the absence of disturbance —
              it is the mastery of correction."
            </p>
            <p className="login-quote-attr">FSOC Virtual PAT · Tracking Intelligence</p>
          </div>

          <div className="login-temple-strip" aria-hidden="true">
            <TempleSilhouette />
          </div>
        </div>

      </div>
    </div>
  );
};
