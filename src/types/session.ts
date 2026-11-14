// Express session type augmentation
import 'express-session';

declare module 'express-session' {
  interface SessionData {
    userId: number;
    userEmail: string;
    emailVerified: boolean;
    pendingNext?: string;
    /** In-flight Google sign-in (state/nonce/PKCE verifier), cleared on the callback. */
    googleOAuth?: { state: string; nonce: string; verifier: string; next?: string; at: number };
  }
}
