import { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { verifyPasswordResetCode, confirmPasswordReset } from 'firebase/auth';
import { auth } from '../firebase/firebase';
import { getAuthErrorMessage } from '../firebase/authErrors';
import './SignUpPage.css';  // reuse all .su-* classes
import './LoginPage.css';   // reuse login layout classes

// ─── Validation (same rules as SignUpPage) ────────────────────────────────────
function validatePassword(v: string): string | undefined {
  if (!v) return 'Please enter a new password.';
  if (v.length < 8)            return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(v))        return 'Password must contain an uppercase letter.';
  if (!/[a-z]/.test(v))        return 'Password must contain a lowercase letter.';
  if (!/[0-9]/.test(v))        return 'Password must contain a number.';
  if (!/[^A-Za-z0-9]/.test(v)) return 'Password must contain a special character.';
  return undefined;
}

interface PasswordReqs {
  length: boolean; upper: boolean; lower: boolean; number: boolean; special: boolean;
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
type StrengthLevel = '' | 'weak' | 'fair' | 'good' | 'strong';
function getStrength(r: PasswordReqs): StrengthLevel {
  const n = Object.values(r).filter(Boolean).length;
  if (n === 0) return ''; if (n <= 2) return 'weak';
  if (n === 3) return 'fair'; if (n === 4) return 'good'; return 'strong';
}

// ─── SVG atoms (same motifs as Login/Signup) ─────────────────────────────────
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
    {[0,45,90,135,180,225,270,315].map((deg) => {
      const rad = (deg * Math.PI) / 180;
      return <line key={deg} x1={10+4*Math.cos(rad)} y1={10+4*Math.sin(rad)}
                   x2={10+7*Math.cos(rad)} y2={10+7*Math.sin(rad)}
                   stroke="#B99550" strokeWidth="0.7" opacity="0.55" />;
    })}
  </svg>
);
const EyeIcon = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" /><circle cx="12" cy="12" r="3" />
  </svg>
);
const EyeOffIcon = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
    <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);
const LockIcon = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
    <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" />
  </svg>
);
const CheckIcon = () => (
  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);
const ErrorDotIcon = () => (
  <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);
const TempleSilhouette = () => (
  <svg viewBox="0 0 900 80" preserveAspectRatio="none" aria-hidden="true">
    <path d="M0 80 L0 55 L50 55 L50 38 L75 38 L75 22 L100 8 L125 22 L125 38 L160 38 L160 55
             L210 55 L210 32 L230 32 L230 18 L248 4 L266 18 L266 32 L286 32 L286 55
             L380 55 L380 38 L405 38 L405 25 L425 12 L445 25 L445 38 L470 38 L470 55
             L540 55 L540 42 L562 42 L562 28 L580 14 L598 28 L598 42 L620 42 L620 55
             L680 55 L680 40 L700 40 L700 26 L715 14 L730 26 L730 40 L755 40 L755 55
             L830 55 L830 45 L850 45 L850 55 L900 55 L900 80 Z"
      fill="var(--gold)" opacity="0.55" />
  </svg>
);

// ─── Component ────────────────────────────────────────────────────────────────
export const ResetPasswordPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const oobCode = searchParams.get('oobCode') ?? '';

  // States
  type PageState = 'verifying' | 'invalid' | 'form' | 'loading' | 'success';
  const [pageState, setPageState] = useState<PageState>('verifying');
  const [verifiedEmail, setVerifiedEmail] = useState('');

  const [password, setPassword]         = useState('');
  const [confirm, setConfirm]           = useState('');
  const [showPw, setShowPw]             = useState(false);
  const [showConfirm, setShowConfirm]   = useState(false);
  const [pwTouched, setPwTouched]       = useState(false);
  const [cfTouched, setCfTouched]       = useState(false);
  const [pwFocused, setPwFocused]       = useState(false);
  const [pwError, setPwError]           = useState('');
  const [cfError, setCfError]           = useState('');
  const [formError, setFormError]       = useState('');

  const pwReqs     = getPasswordReqs(password);
  const strength   = getStrength(pwReqs);
  const strengthLabels: Record<StrengthLevel, string> = {
    '': '', weak: 'Weak', fair: 'Fair', good: 'Good', strong: 'Strong',
  };
  const strengthFill = { '': 0, weak: 1, fair: 2, good: 3, strong: 4 }[strength];

  // 1. Verify the oobCode on mount
  useEffect(() => {
    if (!oobCode) { setPageState('invalid'); return; }
    verifyPasswordResetCode(auth, oobCode)
      .then(email => { setVerifiedEmail(email); setPageState('form'); })
      .catch(() => setPageState('invalid'));
  }, [oobCode]);

  // 2. Live validate
  useEffect(() => {
    if (pwTouched) setPwError(validatePassword(password) ?? '');
  }, [password, pwTouched]);

  useEffect(() => {
    if (cfTouched) {
      setCfError(!confirm ? 'Please confirm your password.'
        : password !== confirm ? 'Passwords do not match.' : '');
    }
  }, [confirm, password, cfTouched]);

  // 3. Submit
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwTouched(true); setCfTouched(true);
    const pe = validatePassword(password);
    const ce = !confirm ? 'Please confirm your password.'
             : password !== confirm ? 'Passwords do not match.' : '';
    if (pe || ce) { setPwError(pe ?? ''); setCfError(ce); return; }

    setPageState('loading');
    setFormError('');
    try {
      await confirmPasswordReset(auth, oobCode, password);
      setPageState('success');
    } catch (err) {
      setFormError(getAuthErrorMessage(err));
      setPageState('form');
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="login-root">

      {/* Background — reuse Taj Mahal from LoginPage */}
      <div className="login-bg" aria-hidden="true">
        <img src="/taj-mahal-hd.jpg" alt="" className="login-bg-img" />
        <div className="login-bg-scrim" />
        <div className="login-bg-glow" />
      </div>

      <div className="login-layout">

        {/* ── LEFT: form card ── */}
        <div className="login-left">
          <div className="signup-card" role="main">
            <span className="su-corner su-corner-tl"><CornerOrn /></span>
            <span className="su-corner su-corner-tr"><CornerOrn /></span>
            <span className="su-corner su-corner-bl"><CornerOrn /></span>
            <span className="su-corner su-corner-br"><CornerOrn /></span>

            {/* ── VERIFYING ── */}
            {pageState === 'verifying' && (
              <div style={{ textAlign: 'center', padding: '32px 0' }}>
                <span className="su-spinner" style={{ margin: '0 auto 16px', display: 'block',
                  width: 24, height: 24, borderWidth: 2,
                  borderColor: 'rgba(185,149,80,0.3)', borderTopColor: 'var(--gold)' }}
                  aria-hidden="true" />
                <p className="signup-card-sub">Verifying your reset link…</p>
              </div>
            )}

            {/* ── INVALID / EXPIRED ── */}
            {pageState === 'invalid' && (
              <div className="su-success" role="alert">
                <div className="su-success-icon" style={{ borderColor: 'rgba(220,80,60,0.4)',
                  background: 'rgba(220,60,40,0.08)' }} aria-hidden="true">
                  <svg viewBox="0 0 48 48" width={28} height={28} fill="none">
                    <circle cx="24" cy="24" r="20" stroke="#e05a4a" strokeWidth="2" />
                    <line x1="16" y1="16" x2="32" y2="32" stroke="#e05a4a" strokeWidth="2.5" strokeLinecap="round" />
                    <line x1="32" y1="16" x2="16" y2="32" stroke="#e05a4a" strokeWidth="2.5" strokeLinecap="round" />
                  </svg>
                </div>
                <div className="su-ornament" aria-hidden="true">
                  <span className="su-ornament-line" /><OrnamentCenter /><span className="su-ornament-line right" />
                </div>
                <p className="signup-card-eyebrow">Link unavailable</p>
                <h2 className="su-success-title">Reset link expired.</h2>
                <p className="su-success-sub">
                  This password reset link is invalid or has already been used.<br />
                  Please request a new one.
                </p>
                <Link to="/login" style={{ display: 'inline-block', marginTop: 4 }}>
                  <button className="su-submit" style={{ marginBottom: 0 }}>
                    Back to Login
                  </button>
                </Link>
              </div>
            )}

            {/* ── SUCCESS ── */}
            {pageState === 'success' && (
              <div className="su-success" role="status" aria-live="polite">
                <div className="su-success-icon" aria-hidden="true">
                  <svg viewBox="0 0 48 48" width={28} height={28} fill="none">
                    <circle cx="24" cy="24" r="20" stroke="#D2A95D" strokeWidth="2" fill="none" />
                    <path d="M14 24l7 7 13-14" stroke="#D2A95D" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <div className="su-ornament" aria-hidden="true">
                  <span className="su-ornament-line" /><OrnamentCenter /><span className="su-ornament-line right" />
                </div>
                <p className="signup-card-eyebrow">Password updated</p>
                <h2 className="su-success-title">All done.</h2>
                <p className="su-success-sub">
                  Your password has been reset successfully.<br />
                  You can now sign in with your new password.
                </p>
                <button
                  className="su-submit"
                  style={{ marginBottom: 0 }}
                  onClick={() => navigate('/login')}
                >
                  Sign In ✦
                </button>
              </div>
            )}

            {/* ── FORM (and loading state reuses disabled submit button) ── */}
            {(pageState === 'form' || pageState === 'loading') && (
              <>
                <p className="signup-card-eyebrow">Set new password</p>
                <h2 className="signup-card-title">Reset your password</h2>
                {verifiedEmail && (
                  <p className="signup-card-sub">
                    for <strong style={{ color: 'var(--gold-2)' }}>{verifiedEmail}</strong>
                  </p>
                )}

                <div className="su-ornament" aria-hidden="true">
                  <span className="su-ornament-line" /><OrnamentCenter /><span className="su-ornament-line right" />
                </div>

                {formError && (
                  <div className="su-error visible" role="alert" aria-live="polite"
                    style={{ justifyContent: 'center', marginBottom: 16, fontSize: 13 }}>
                    <ErrorDotIcon /> {formError}
                  </div>
                )}

                <form className="su-form" onSubmit={handleSubmit} noValidate aria-label="Reset password form">

                  {/* ── New password ── */}
                  <div className="su-field">
                    <label htmlFor="rp-password">New Password</label>
                    <div className="su-input-wrap">
                      <span className="su-input-icon"><LockIcon /></span>
                      <input
                        id="rp-password"
                        type={showPw ? 'text' : 'password'}
                        autoComplete="new-password"
                        placeholder="Create a strong password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        onBlur={() => setPwTouched(true)}
                        onFocus={() => setPwFocused(true)}
                        className={`su-input has-toggle${pwTouched && pwError ? ' error' : pwTouched && !pwError && password ? ' success' : ''}`}
                        aria-invalid={!!(pwTouched && pwError)}
                        aria-describedby="rp-pw-err rp-strength"
                      />
                      <button type="button" className="su-pw-toggle"
                        onClick={() => setShowPw(s => !s)}
                        aria-label={showPw ? 'Hide password' : 'Show password'}>
                        {showPw ? <EyeOffIcon /> : <EyeIcon />}
                      </button>
                    </div>
                    <span id="rp-pw-err" className={`su-error${pwTouched && pwError ? ' visible' : ''}`} role="alert">
                      {pwError && <><ErrorDotIcon /> {pwError}</>}
                    </span>

                    {/* Password strength */}
                    {(pwFocused || password) && (
                      <div className="su-strength" id="rp-strength" aria-live="polite">
                        <div className="su-strength-bar" role="presentation"
                          aria-label={`Password strength: ${strengthLabels[strength]}`}>
                          {[0,1,2,3].map(i => (
                            <span key={i} className={`su-strength-seg${i < strengthFill ? ` ${strength}` : ''}`} />
                          ))}
                        </div>
                        {strength && <span className={`su-strength-label ${strength}`}>{strengthLabels[strength]}</span>}
                        <div className="su-requirements" aria-label="Password requirements">
                          {([
                            { key: 'length'  as const, label: '8+ characters'    },
                            { key: 'upper'   as const, label: 'Uppercase letter'  },
                            { key: 'lower'   as const, label: 'Lowercase letter'  },
                            { key: 'number'  as const, label: 'Number'            },
                            { key: 'special' as const, label: 'Special character' },
                          ]).map(({ key, label }) => (
                            <span key={key} className={`su-req${pwReqs[key] ? ' met' : ''}`}
                              aria-label={`${label}: ${pwReqs[key] ? 'met' : 'not met'}`}>
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

                  {/* ── Confirm password ── */}
                  <div className="su-field">
                    <label htmlFor="rp-confirm">Confirm Password</label>
                    <div className="su-input-wrap">
                      <span className="su-input-icon"><LockIcon /></span>
                      <input
                        id="rp-confirm"
                        type={showConfirm ? 'text' : 'password'}
                        autoComplete="new-password"
                        placeholder="Repeat your new password"
                        value={confirm}
                        onChange={e => setConfirm(e.target.value)}
                        onBlur={() => setCfTouched(true)}
                        className={`su-input has-toggle${cfTouched && cfError ? ' error' : cfTouched && !cfError && confirm ? ' success' : ''}`}
                        aria-invalid={!!(cfTouched && cfError)}
                        aria-describedby="rp-cf-err"
                      />
                      <button type="button" className="su-pw-toggle"
                        onClick={() => setShowConfirm(s => !s)}
                        aria-label={showConfirm ? 'Hide confirm password' : 'Show confirm password'}>
                        {showConfirm ? <EyeOffIcon /> : <EyeIcon />}
                      </button>
                    </div>
                    <span id="rp-cf-err" className={`su-error${cfTouched && cfError ? ' visible' : ''}`} role="alert">
                      {cfError && <><ErrorDotIcon /> {cfError}</>}
                    </span>
                  </div>

                  <button type="submit" className="su-submit"
                    disabled={pageState === 'loading'} aria-busy={pageState === 'loading'}>
                    {pageState === 'loading'
                      ? <><span className="su-spinner" aria-hidden="true" /> Updating password…</>
                      : 'Set New Password ✦'}
                  </button>

                  <p className="su-signup-row">
                    Remember it after all? <Link to="/login">Sign in</Link>
                  </p>
                </form>
              </>
            )}
          </div>
        </div>

        {/* ── RIGHT: branding copy ── */}
        <div className="login-right">
          <Link to="/" className="login-brand-row" aria-label="MICHIRA home">
            <BrandLogo />
            <span className="login-brand-name">MICHIRA</span>
          </Link>

          <div className="login-right-eyebrow">
            <span className="ey-line" />
            India · Heritage · Discovery
          </div>

          <h2 className="login-right-headline">
            A new key<br />
            to your<br />
            <em>journey.</em>
          </h2>

          <p className="login-right-sub">
            Set a strong new password and pick up exactly where you left off —
            every destination, every itinerary, every insight, still waiting.
          </p>

          <div className="login-quote">
            <p className="login-quote-text">
              "Every ending is a new beginning — even for passwords."
            </p>
            <p className="login-quote-attr">MICHIRA · Travel Intelligence</p>
          </div>

          <div className="login-temple-strip" aria-hidden="true">
            <TempleSilhouette />
          </div>
        </div>

      </div>
    </div>
  );
};
