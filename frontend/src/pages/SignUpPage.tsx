import { useState, useCallback, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  createUserWithEmailAndPassword,
  updateProfile,
  sendEmailVerification,
  signInWithPopup,
} from 'firebase/auth';
import { auth, googleProvider } from '../firebase/firebase';
import { getAuthErrorMessage } from '../firebase/authErrors';
import { useAuth } from '../context/AuthContext';
import './SignUpPage.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FormFields {
  fullName: string;
  email: string;
  password: string;
  confirmPassword: string;
  agreed: boolean;
}

interface FormErrors {
  fullName?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
  agreed?: string;
  form?: string;
}

interface PasswordReqs {
  length: boolean;
  upper: boolean;
  lower: boolean;
  number: boolean;
  special: boolean;
}

type StrengthLevel = '' | 'weak' | 'fair' | 'good' | 'strong';

// ─── Validation helpers ───────────────────────────────────────────────────────

function validateFullName(v: string): string | undefined {
  const t = v.trim();
  if (!t) return 'Please enter your full name.';
  if (t.length < 2) return 'Name must be at least 2 characters.';
  if (/^[^a-zA-Z]+$/.test(t)) return 'Name must contain at least one letter.';
  return undefined;
}

function validateEmail(v: string): string | undefined {
  const t = v.trim().toLowerCase();
  if (!t) return 'Please enter your email address.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t)) return 'Please enter a valid email address.';
  return undefined;
}

function validatePassword(v: string): string | undefined {
  if (!v) return 'Please enter a password.';
  if (v.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(v)) return 'Password must contain an uppercase letter.';
  if (!/[a-z]/.test(v)) return 'Password must contain a lowercase letter.';
  if (!/[0-9]/.test(v)) return 'Password must contain a number.';
  if (!/[^A-Za-z0-9]/.test(v)) return 'Password must contain a special character.';
  return undefined;
}

function validateConfirm(pw: string, confirm: string): string | undefined {
  if (!confirm) return 'Please confirm your password.';
  if (pw !== confirm) return 'Passwords do not match.';
  return undefined;
}

function getPasswordReqs(pw: string): PasswordReqs {
  return {
    length:  pw.length >= 8,
    upper:   /[A-Z]/.test(pw),
    lower:   /[a-z]/.test(pw),
    number:  /[0-9]/.test(pw),
    special: /[^A-Za-z0-9]/.test(pw),
  };
}

function getStrength(reqs: PasswordReqs): StrengthLevel {
  const count = Object.values(reqs).filter(Boolean).length;
  if (count === 0) return '';
  if (count <= 2) return 'weak';
  if (count === 3) return 'fair';
  if (count === 4) return 'good';
  return 'strong';
}

// ─── SVG atoms ────────────────────────────────────────────────────────────────

const BrandLogo = () => (
  <svg viewBox="0 0 40 40" fill="none" width={30} height={30} aria-hidden="true">
    <path d="M20 3 L27 13 L27 16 L13 16 L13 13 Z" fill="#B99550" />
    <rect x="15" y="16" width="10" height="16" fill="none" stroke="#B99550" strokeWidth="1" />
    <path d="M11 32 H29 V36 H11 Z" fill="#B99550" opacity="0.9" />
    <circle cx="20" cy="9" r="1.4" fill="#0B0D0D" />
  </svg>
);

// Corner ornament — a simple L-shaped filigree matching the landing page motif
const CornerOrn = () => (
  <svg viewBox="0 0 22 22" fill="none" aria-hidden="true">
    <path d="M2 20 L2 2 L20 2" stroke="#B99550" strokeWidth="1" fill="none" />
    <path d="M2 2 L6 6" stroke="#B99550" strokeWidth="0.8" />
    <circle cx="2" cy="2" r="1.2" fill="#B99550" />
    <circle cx="20" cy="2" r="0.8" fill="#B99550" opacity="0.5" />
    <circle cx="2" cy="20" r="0.8" fill="#B99550" opacity="0.5" />
  </svg>
);

// Mandala / lotus ring ornament for the divider
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

// Google G icon
const GoogleIcon = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
  </svg>
);

// Eye / eye-off icons
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

// Check mark for requirements
const CheckIcon = () => (
  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

// Field icons
const UserIcon = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c1.5-4 5-6 8-6s6.5 2 8 6" />
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

// ─── Temple silhouette path ───────────────────────────────────────────────────
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

export const SignUpPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isLoggedIn } = useAuth();
  const redirectTo = searchParams.get('redirect') || '/mission';

  // Already logged in — bounce straight to destination
  useEffect(() => {
    if (isLoggedIn) navigate(redirectTo, { replace: true });
  }, [isLoggedIn, navigate, redirectTo]);

  const [form, setForm] = useState<FormFields>({
    fullName: '',
    email: '',
    password: '',
    confirmPassword: '',
    agreed: false,
  });

  const [errors, setErrors]           = useState<FormErrors>({});
  const [touched, setTouched]         = useState<Record<string, boolean>>({});
  const [showPw, setShowPw]           = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading]         = useState(false);
  const [submitted, setSubmitted]     = useState(false);
  const [pwFocused, setPwFocused]     = useState(false);

  const pwReqs    = getPasswordReqs(form.password);
  const strength  = getStrength(pwReqs);

  // Live validate touched fields
  useEffect(() => {
    const next: FormErrors = {};
    if (touched.fullName)        next.fullName        = validateFullName(form.fullName);
    if (touched.email)           next.email           = validateEmail(form.email);
    if (touched.password)        next.password        = validatePassword(form.password);
    if (touched.confirmPassword) next.confirmPassword = validateConfirm(form.password, form.confirmPassword);
    if (touched.agreed && !form.agreed) next.agreed   = 'You must agree to the terms to continue.';
    setErrors(next);
  }, [form, touched]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    setForm(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  }, []);

  const handleBlur = useCallback((name: string) => {
    setTouched(prev => ({ ...prev, [name]: true }));
  }, []);

  const isFormValid = useCallback((): boolean => {
    return (
      !validateFullName(form.fullName) &&
      !validateEmail(form.email) &&
      !validatePassword(form.password) &&
      !validateConfirm(form.password, form.confirmPassword) &&
      form.agreed
    );
  }, [form]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Touch all fields to surface errors
    setTouched({
      fullName: true, email: true, password: true,
      confirmPassword: true, agreed: true,
    });

    if (!isFormValid()) return;

    setLoading(true);

    try {
      // 1. Create Firebase user with email + password
      const credential = await createUserWithEmailAndPassword(
        auth,
        form.email.trim().toLowerCase(),
        form.password,
      );
      const firebaseUser = credential.user;

      // 2. Persist display name (phone can be added to Firestore if needed later)
      await updateProfile(firebaseUser, {
        displayName: form.fullName.trim(),
      });

      // 3. Send email verification
      await sendEmailVerification(firebaseUser);

      // 4. onAuthStateChanged fires automatically — no manual login() call needed
      setLoading(false);
      setSubmitted(true);
      setTimeout(() => navigate(redirectTo), 2800);
    } catch (err) {
      setErrors(prev => ({ ...prev, form: getAuthErrorMessage(err) }));
      setLoading(false);
    }
  };

  // ── Strength bar helpers ──────────────────────────────────────────────────
  const strengthLabels: Record<StrengthLevel, string> = {
    '': '', weak: 'Weak', fair: 'Fair', good: 'Good', strong: 'Strong',
  };
  const strengthFill = { '': 0, weak: 1, fair: 2, good: 3, strong: 4 }[strength];

  // ── Input class helper ────────────────────────────────────────────────────
  const inputCls = (name: keyof FormErrors, extra = '') => {
    const hasErr = touched[name] && errors[name];
    const isOk   = touched[name] && !errors[name] && form[name as keyof FormFields];
    return `su-input${hasErr ? ' error' : isOk ? ' success' : ''} ${extra}`.trim();
  };

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="signup-root">

      {/* ── Fixed background ── */}
      <div className="signup-bg" aria-hidden="true">
        <img
          src="/hero-space.jpg"
          alt=""
          className="signup-bg-img"
        />
        <div className="signup-bg-scrim" />
        <div className="signup-bg-glow" />
      </div>

      {/* ── Two-column layout ── */}
      <div className="signup-layout">

        {/* ════════════════════════════════════════
            LEFT — branding + heritage copy
            ════════════════════════════════════════ */}
        <div className="signup-left">

          <Link to="/" className="signup-brand-row" aria-label="FSOC Track home">
            <BrandLogo />
            <span className="signup-brand-name">FSOC·TRACK</span>
          </Link>

          <div className="signup-left-eyebrow">
            <span className="ey-line" />
            FSOC · Mission Software
          </div>

          <h1 className="signup-left-headline">
            Your mission<br />
            starts with<br />
            <em>precision.</em>
          </h1>

          <p className="signup-left-sub">
            Simulate the full optical tracking pipeline — from beacon
            detection through predictive control and mission analytics.
          </p>

          <div className="signup-features" role="list">
            {[
              'Virtual environment configuration',
              'AI-assisted beacon detection',
              'Kalman predictive tracking',
              'Live performance telemetry',
            ].map(f => (
              <div className="signup-feature-item" role="listitem" key={f}>
                <span className="signup-feature-dot" aria-hidden="true" />
                {f}
              </div>
            ))}
          </div>

          <div className="signup-temple-strip" aria-hidden="true">
            <TempleSilhouette />
          </div>
        </div>

        {/* ════════════════════════════════════════
            RIGHT — form card
            ════════════════════════════════════════ */}
        <div className="signup-right">
          <div className="signup-card" role="main">

            {/* Corner ornaments */}
            <span className="su-corner su-corner-tl"><CornerOrn /></span>
            <span className="su-corner su-corner-tr"><CornerOrn /></span>
            <span className="su-corner su-corner-bl"><CornerOrn /></span>
            <span className="su-corner su-corner-br"><CornerOrn /></span>

            {submitted ? (
              /* ── SUCCESS STATE ─────────────────────── */
              <div className="su-success" role="status" aria-live="polite">
                <div className="su-success-icon" aria-hidden="true">
                  {/* Diya flame motif */}
                  <svg viewBox="0 0 48 56" width={36} height={36} fill="none">
                    <path d="M24 8 C18 18 15 26 24 36 C33 26 30 18 24 8 Z" fill="#D2A95D" />
                    <path d="M24 18 C20 25 19 30 24 35 C29 30 28 25 24 18 Z" fill="#F3D28A" />
                    <path d="M24 28 C22.5 31 22 33 24 35 C26 33 25.5 31 24 28 Z" fill="#FFF3D6" />
                    <line x1="24" y1="36" x2="24" y2="44" stroke="#2a1a0c" strokeWidth="2" />
                    <path d="M6 48 Q24 56 42 48 Q38 40 24 40 Q10 40 6 48 Z" fill="#5b3a1e" />
                  </svg>
                </div>

                <div className="su-ornament" aria-hidden="true">
                  <span className="su-ornament-line" />
                  <OrnamentCenter />
                  <span className="su-ornament-line right" />
                </div>

                <p className="signup-card-eyebrow">SYSTEM ACCESS GRANTED</p>
                <h2 className="su-success-title">Your account is ready.</h2>
                <p className="su-success-sub">
                  Your mission workspace is ready.<br />
                  Configure, simulate and track with confidence.
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
                  Redirecting to mission control…
                </p>
              </div>
            ) : (
              /* ── SIGN UP FORM ───────────────────────── */
              <>
                <p className="signup-card-eyebrow">IDENTITY REGISTRATION</p>
                <h2 className="signup-card-title">Create operator access</h2>
                <p className="signup-card-sub">Register an operator profile for the FSOC tracking workstation.</p>

                <div className="su-ornament" aria-hidden="true">
                  <span className="su-ornament-line" />
                  <OrnamentCenter />
                  <span className="su-ornament-line right" />
                </div>

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
                  aria-label="Sign up form"
                >
                  {/* ── Full Name ── */}
                  <div className="su-field">
                    <label htmlFor="fullName">Full Name</label>
                    <div className="su-input-wrap">
                      <span className="su-input-icon"><UserIcon /></span>
                      <input
                        id="fullName"
                        name="fullName"
                        type="text"
                        autoComplete="name"
                        placeholder="Aarav Sharma"
                        value={form.fullName}
                        onChange={handleChange}
                        onBlur={() => handleBlur('fullName')}
                        className={inputCls('fullName')}
                        aria-invalid={!!(touched.fullName && errors.fullName)}
                        aria-describedby="fullName-err"
                      />
                    </div>
                    <span
                      id="fullName-err"
                      className={`su-error${touched.fullName && errors.fullName ? ' visible' : ''}`}
                      role="alert"
                    >
                      {errors.fullName && <><ErrorDotIcon /> {errors.fullName}</>}
                    </span>
                  </div>

                  {/* ── Email ── */}
                  <div className="su-field">
                    <label htmlFor="email">Email Address</label>
                    <div className="su-input-wrap">
                      <span className="su-input-icon"><MailIcon /></span>
                      <input
                        id="email"
                        name="email"
                        type="email"
                        autoComplete="email"
                        placeholder="aarav@example.com"
                        value={form.email}
                        onChange={handleChange}
                        onBlur={() => handleBlur('email')}
                        className={inputCls('email')}
                        aria-invalid={!!(touched.email && errors.email)}
                        aria-describedby="email-err"
                      />
                    </div>
                    <span
                      id="email-err"
                      className={`su-error${touched.email && errors.email ? ' visible' : ''}`}
                      role="alert"
                    >
                      {errors.email && <><ErrorDotIcon /> {errors.email}</>}
                    </span>
                  </div>

                  {/* ── Password ── */}
                  <div className="su-field">
                    <label htmlFor="password">Password</label>
                    <div className="su-input-wrap">
                      <span className="su-input-icon"><LockIcon /></span>
                      <input
                        id="password"
                        name="password"
                        type={showPw ? 'text' : 'password'}
                        autoComplete="new-password"
                        placeholder="Create a strong password"
                        value={form.password}
                        onChange={handleChange}
                        onBlur={() => { handleBlur('password'); setPwFocused(false); }}
                        onFocus={() => setPwFocused(true)}
                        className={inputCls('password', 'has-toggle')}
                        aria-invalid={!!(touched.password && errors.password)}
                        aria-describedby="password-err password-strength"
                      />
                      <button
                        type="button"
                        className="su-pw-toggle"
                        onClick={() => setShowPw(s => !s)}
                        aria-label={showPw ? 'Hide password' : 'Show password'}
                        tabIndex={0}
                      >
                        {showPw ? <EyeOffIcon /> : <EyeIcon />}
                      </button>
                    </div>
                    <span
                      id="password-err"
                      className={`su-error${touched.password && errors.password ? ' visible' : ''}`}
                      role="alert"
                    >
                      {errors.password && <><ErrorDotIcon /> {errors.password}</>}
                    </span>

                    {/* Password strength — show when focused or has value */}
                    {(pwFocused || form.password) && (
                      <div className="su-strength" id="password-strength" aria-live="polite">
                        <div className="su-strength-bar" role="presentation" aria-label={`Password strength: ${strengthLabels[strength]}`}>
                          {[0, 1, 2, 3].map(i => (
                            <span
                              key={i}
                              className={`su-strength-seg${i < strengthFill ? ` ${strength}` : ''}`}
                            />
                          ))}
                        </div>
                        {strength && (
                          <span className={`su-strength-label ${strength}`}>{strengthLabels[strength]}</span>
                        )}
                        <div className="su-requirements" aria-label="Password requirements">
                          {([
                            { key: 'length',  label: '8+ characters'      },
                            { key: 'upper',   label: 'Uppercase letter'    },
                            { key: 'lower',   label: 'Lowercase letter'    },
                            { key: 'number',  label: 'Number'              },
                            { key: 'special', label: 'Special character'   },
                          ] as { key: keyof PasswordReqs; label: string }[]).map(({ key, label }) => (
                            <span
                              key={key}
                              className={`su-req${pwReqs[key] ? ' met' : ''}`}
                              aria-label={`${label}: ${pwReqs[key] ? 'met' : 'not met'}`}
                            >
                              <span className="su-req-dot" aria-hidden="true">
                                {pwReqs[key] && <CheckIcon />}
                              </span>
                              {label}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* ── Confirm Password ── */}
                  <div className="su-field">
                    <label htmlFor="confirmPassword">Confirm Password</label>
                    <div className="su-input-wrap">
                      <span className="su-input-icon"><LockIcon /></span>
                      <input
                        id="confirmPassword"
                        name="confirmPassword"
                        type={showConfirm ? 'text' : 'password'}
                        autoComplete="new-password"
                        placeholder="Repeat your password"
                        value={form.confirmPassword}
                        onChange={handleChange}
                        onBlur={() => handleBlur('confirmPassword')}
                        className={inputCls('confirmPassword', 'has-toggle')}
                        aria-invalid={!!(touched.confirmPassword && errors.confirmPassword)}
                        aria-describedby="confirm-err"
                      />
                      <button
                        type="button"
                        className="su-pw-toggle"
                        onClick={() => setShowConfirm(s => !s)}
                        aria-label={showConfirm ? 'Hide confirm password' : 'Show confirm password'}
                        tabIndex={0}
                      >
                        {showConfirm ? <EyeOffIcon /> : <EyeIcon />}
                      </button>
                    </div>
                    <span
                      id="confirm-err"
                      className={`su-error${touched.confirmPassword && errors.confirmPassword ? ' visible' : ''}`}
                      role="alert"
                    >
                      {errors.confirmPassword && <><ErrorDotIcon /> {errors.confirmPassword}</>}
                    </span>
                  </div>

                  {/* ── Terms ── */}
                  <div className="su-terms">
                    <input
                      id="agreed"
                      name="agreed"
                      type="checkbox"
                      className="su-checkbox"
                      checked={form.agreed}
                      onChange={handleChange}
                      onBlur={() => handleBlur('agreed')}
                      aria-required="true"
                      aria-invalid={!!(touched.agreed && errors.agreed)}
                      aria-describedby="terms-err"
                    />
                    <label htmlFor="agreed" className="su-terms-label">
                      I agree to the{' '}
                      <a href="#" onClick={e => e.preventDefault()}>Terms of Service</a>
                      {' '}and{' '}
                      <a href="#" onClick={e => e.preventDefault()}>Privacy Policy</a>.
                    </label>
                  </div>
                  {touched.agreed && errors.agreed && (
                    <span
                      id="terms-err"
                      className="su-error visible"
                      role="alert"
                      style={{ marginTop: '-8px', marginBottom: '12px' }}
                    >
                      <ErrorDotIcon /> {errors.agreed}
                    </span>
                  )}

                  {/* ── Submit ── */}
                  <button
                    type="submit"
                    className="su-submit"
                    disabled={loading}
                    aria-busy={loading}
                  >
                    {loading ? (
                      <><span className="su-spinner" aria-hidden="true" /> Creating your account…</>
                    ) : (
                      <>Create Account ✦</>
                    )}
                  </button>

                  {/* ── Social signup ── */}
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
                          await signInWithPopup(auth, googleProvider);
                          // onAuthStateChanged fires automatically
                          navigate(redirectTo);
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

                  {/* ── Login link ── */}
                  <p className="su-login-row">
                    Already have an account?
                    <Link to="/login">Log in</Link>
                  </p>
                </form>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
