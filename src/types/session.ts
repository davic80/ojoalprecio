// Express session type augmentation
import 'express-session';

declare module 'express-session' {
  interface SessionData {
    userId: number;
    userEmail: string;
    emailVerified: boolean;
  }
}
