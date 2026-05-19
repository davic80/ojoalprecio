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
import listsRouter from './routes/lists';
import accountRouter from './routes/account';
import aliexpressRouter from './routes/aliexpress';
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

  app.set('trust proxy', 1);

  app.use(
    session({
      store: new PgSession({
        pool,
        tableName: 'user_sessions',
        createTableIfMissing: true,
        ttl: 30 * 24 * 60 * 60, // 30 days in seconds
      }),
      secret: process.env.SESSION_SECRET ?? 'change_me_to_a_random_secret',
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        secure: process.env.SESSION_COOKIE_SECURE === 'true',
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        sameSite: 'lax',
      },
    }),
  );

  // ── Page view tracking (fire-and-forget, excludes static/HTMX/admin) ─────────

  function categorizeReferer(req: express.Request): string | null {
    const raw = ((req.headers['referer'] ?? req.headers['referrer'] ?? '') as string);
    if (raw) {
      let host = '';
      try { host = new URL(raw).hostname.toLowerCase().replace(/^www\./, ''); }
      catch { return 'Otro'; }
      // Skip internal navigation (same-site referer)
      const siteHost = process.env.SITE_URL ? (() => { try { return new URL(process.env.SITE_URL!).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } })() : '';
      const ownHost  = ((req.headers['host'] as string) ?? '').split(':')[0].toLowerCase().replace(/^www\./, '');
      if ((siteHost && host === siteHost) || (ownHost && host === ownHost)) return null;
      if (host === 't.me' || host.endsWith('.t.me'))       return 'Telegram';
      if (host.startsWith('google.'))                      return 'Google';
      if (host === 'bing.com')                             return 'Bing';
      if (host === 'instagram.com')                        return 'Instagram';
      if (host === 'twitter.com' || host === 'x.com')      return 'Twitter/X';
      return 'Otro';
    }
    // UTM fallback when there is no Referer
    const utm = String(req.query['utm_source'] ?? '').toLowerCase();
    if (utm === 'telegram') return 'Telegram';
    if (utm === 'email')    return 'Email';
    if (utm === 'google')   return 'Google';
    return 'Directo';
  }

  function detectDevice(ua: string): string {
    const u = ua.toLowerCase();
    if (!u ||
        u.includes('bot') || u.includes('crawler') || u.includes('spider') ||
        u.includes('curl/') || u.includes('python-requests') || u.includes('go-http-client') ||
        u.includes('wget/') || u.includes('scrapy') || u.includes('facebookexternalhit') ||
        u.includes('twitterbot') || u.includes('semrushbot') || u.includes('ahrefsbot') ||
        u.includes('petalbot') || u.includes('slurp') || u.includes('duckduckbot')) {
      return 'Bot';
    }
    if (u.includes('ipad') || (u.includes('android') && !u.includes('mobile'))) return 'Tablet';
    if (u.includes('mobile') || u.includes('iphone') || u.includes('ipod') || u.includes('android')) return 'Móvil';
    return 'Escritorio';
  }

  app.use((req, _res, next) => {
    const skip =
      req.method !== 'GET' ||
      req.headers['hx-request'] ||
      req.path.startsWith('/admin') ||
      req.path.startsWith('/auth') ||
      req.path.startsWith('/css') ||
      req.path.startsWith('/js') ||
      req.path.includes('.');
    if (!skip) {
      const source = categorizeReferer(req);
      if (source !== null) {
        const device = detectDevice((req.headers['user-agent'] ?? '') as string);
        const day = new Date().toISOString().slice(0, 10);
        const p = req.path || '/';
        pool.query(
          `INSERT INTO page_views (path, day, source, device_type, count) VALUES ($1, $2, $3, $4, 1)
           ON CONFLICT (path, day, source, device_type) DO UPDATE SET count = page_views.count + 1`,
          [p, day, source, device],
        ).catch(() => {});
      }
    }
    next();
  });

  // ── Routes ───────────────────────────────────────────────────────────────────
  app.use('/auth', authRouter);
  app.use('/', accountRouter);
  app.use('/', adminRouter);
  app.use('/', publicRouter);
  app.use('/', productsRouter);
  app.use('/', pricesRouter);
  app.use('/', alertsRouter);
  app.use('/', listsRouter);
  app.use('/', aliexpressRouter);

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
