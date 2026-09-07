/**
 * Maps Firebase Auth error codes to friendly user-facing messages.
 * Never show raw Firebase error messages to users.
 */
const ERROR_MAP: Record<string, string> = {
  // ── Credentials ──────────────────────────────────────────────────────────
  'auth/invalid-credential':        'Incorrect email or password.',
  'auth/user-not-found':            'No account found with this email.',
  'auth/wrong-password':            'Incorrect password. Please try again.',
  'auth/invalid-email':             'Please enter a valid email address.',
  'auth/email-already-in-use':      'An account with this email already exists. Try signing in instead.',
  'auth/weak-password':             'Password is too weak. Please choose a stronger password.',

  // ── Account state ─────────────────────────────────────────────────────────
  'auth/user-disabled':             'This account has been disabled. Please contact support.',
  'auth/operation-not-allowed':     'This sign-in method is not enabled. Please contact support.',
  'auth/account-exists-with-different-credential':
    'An account already exists with this email using a different sign-in method.',

  // ── Popup / OAuth ─────────────────────────────────────────────────────────
  'auth/popup-closed-by-user':      'Sign-in cancelled. The popup was closed before completing.',
  'auth/popup-blocked':             'Pop-up blocked by your browser. Please allow pop-ups for this site.',
  'auth/cancelled-popup-request':   'Another sign-in pop-up is already open.',

  // ── Password reset / action codes ─────────────────────────────────────────
  'auth/expired-action-code':       'This link has expired. Please request a new one.',
  'auth/invalid-action-code':       'This link is invalid or has already been used.',

  // ── Rate-limiting / network ───────────────────────────────────────────────
  'auth/too-many-requests':         'Too many attempts. Please wait a while and try again.',
  'auth/network-request-failed':    'Network error. Please check your connection and try again.',

  // ── Miscellaneous ─────────────────────────────────────────────────────────
  'auth/requires-recent-login':     'Please sign in again to complete this action.',
  'auth/credential-already-in-use': 'These credentials are already associated with another account.',
  'auth/missing-email':             'Please enter an email address.',
};

/**
 * Returns a friendly error message for a Firebase Auth error.
 * Falls back to the message on the error object, or a generic string.
 */
export function getAuthErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: string }).code;
    if (ERROR_MAP[code]) return ERROR_MAP[code];
  }
  if (error instanceof Error && error.message) {
    // Last-resort: strip Firebase's internal prefix
    return error.message.replace('Firebase: ', '').replace(/ \(auth\/.*?\)\.?$/, '').trim();
  }
  return 'Something went wrong. Please try again.';
}
