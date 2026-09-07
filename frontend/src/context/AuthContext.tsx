import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
} from 'react';
import {
  User,
  onAuthStateChanged,
  signOut,
  browserLocalPersistence,
  browserSessionPersistence,
  setPersistence,
} from 'firebase/auth';
import { auth } from '../firebase/firebase';

// ─── Context shape ────────────────────────────────────────────────────────────
// Backwards-compatible: keeps login() / logout() / isLoggedIn so every
// component that already calls useAuth() continues to work unchanged.
// New Firebase-aware consumers can also use `user` and `authLoading`.

interface AuthContextValue {
  /** Raw Firebase user object — null when signed out, undefined while loading */
  user: User | null;
  /** True while onAuthStateChanged hasn't fired yet (app boot) */
  authLoading: boolean;
  /** Convenience boolean used by useAuthGuard and existing components */
  isLoggedIn: boolean;
  /**
   * Legacy helper kept for backwards compatibility.
   * New code should call Firebase auth functions directly (signInWithEmailAndPassword etc.)
   * and let onAuthStateChanged update the context automatically.
   * Calling login() manually is a no-op in the Firebase implementation —
   * state is driven entirely by Firebase.
   */
  login: () => void;
  /** Signs the current user out via Firebase */
  logout: () => Promise<void>;
  /**
   * Sets Firebase session persistence before signing in.
   * Pass true for "remember me" (browserLocalPersistence),
   * false for session-only (browserSessionPersistence).
   */
  setPersistenceMode: (remember: boolean) => Promise<void>;
}

// ─── Context ──────────────────────────────────────────────────────────────────
const AuthContext = createContext<AuthContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────
export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser]               = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // Subscribe to Firebase auth state — single source of truth
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setAuthLoading(false);
    });
    return unsubscribe; // cleans up listener on unmount
  }, []);

  // isLoggedIn: backwards-compatible boolean
  const isLoggedIn = user !== null;

  // login() kept as no-op for backward compat — Firebase drives state via
  // onAuthStateChanged; callers don't need to manually signal login anymore.
  const login = useCallback(() => {
    // intentional no-op: state updates automatically from onAuthStateChanged
  }, []);

  const logout = useCallback(async () => {
    await signOut(auth);
    // onAuthStateChanged will fire and set user → null automatically
  }, []);

  const setPersistenceMode = useCallback(async (remember: boolean) => {
    await setPersistence(
      auth,
      remember ? browserLocalPersistence : browserSessionPersistence,
    );
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, authLoading, isLoggedIn, login, logout, setPersistenceMode }}
    >
      {children}
    </AuthContext.Provider>
  );
};

// ─── Hook ─────────────────────────────────────────────────────────────────────
export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
};
