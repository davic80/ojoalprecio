import express from 'express';
import path from 'path';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { pool } from './db/client';
import authRouter from './routes/auth';
import productsRouter from './routes/products';
import pricesRouter from './routes/prices';
import alertsRouter from './routes/alerts';
import publicRouter from './routes/public';
import adminRouter from './routes/admin';
import './types/session';

const PgSession = connectPgSimple(session);

export function createApp() {
  const app = express();

  // ── View engine ─────────────────────────────────────────────────────────────
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // ── Middleware ───────────────────────────────────────────────────────────────
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.use(
    session({
      store: new PgSession({
        pool,
        tableName: 'user_sessions',
        createTableIfMissing: true,
      }),
      secret: process.env.SESSION_SECRET ?? 'change_me_to_a_random_secret',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.SESSION_COOKIE_SECURE === 'true',
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        sameSite: 'lax',
      },
    }),
  );

  // ── Routes ───────────────────────────────────────────────────────────────────
  app.use('/auth', authRouter);
  app.use('/', adminRouter);
  app.use('/', publicRouter);
  app.use('/', productsRouter);
  app.use('/', pricesRouter);
  app.use('/', alertsRouter);

  // ── 404 handler ──────────────────────────────────────────────────────────────
  app.use((req, res) => {
    res.status(404).render('404', { user: { email: req.session?.userEmail ?? '' } });
  });

  // ── Error handler ─────────────────────────────────────────────────────────────
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[server] Unhandled error:', err);
    res.status(500).render('error', {
      user: { email: req.session?.userEmail ?? '' },
      message: process.env.NODE_ENV === 'production' ? 'Error interno del servidor.' : err.message,
    });
  });

  return app;
}
