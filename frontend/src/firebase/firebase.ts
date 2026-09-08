import { initializeApp, getApps } from 'firebase/app';
import { getAuth, GoogleAuthProvider, type Auth } from 'firebase/auth';

// All values come from Vite environment variables — never hard-coded.
// Copy .env.example → .env and fill in your Firebase project values.
const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY            as string,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN        as string,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID         as string,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET     as string,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID             as string,
};

export const demoMode = import.meta.env.VITE_DEMO_MODE === 'true';
const hasFirebaseConfig = Object.values(firebaseConfig).every(Boolean);

// Guard against double-initialisation in HMR / strict-mode
const app = hasFirebaseConfig
  ? (getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0])
  : null;

// Auth is only used when Firebase is configured. Demo mode bypasses it through
// AuthProvider, while the cast preserves the existing Firebase call sites.
export const auth = app ? getAuth(app) : null as unknown as Auth;

export const googleProvider = new GoogleAuthProvider();
// Request profile + email scopes so display name is always available
googleProvider.addScope('profile');
googleProvider.addScope('email');
