import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { body, validationResult } from 'express-validator';
import { db } from '../db/client';
import { users, emailVerifications, passwordResets } from '../db/schema';
import { eq, and, gt } from 'drizzle-orm';
import { sendVerificationEmail, sendPasswordResetEmail, sendWelcomeEmail } from '../mailer/index';
import { googleConfig, randomToken, pkcePair, buildAuthUrl, exchangeCode, verifyIdToken, passwordSignupEnabled } from '../lib/google-auth';
import { resolveGoogleUser, GoogleEmailNotVerified, GoogleAccountConflict } from '../lib/google-user';

const router = Router();

// Validate that a `next` URL is local (no scheme/host injection).
function safeNext(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s.startsWith('/') || s.startsWith('//')) return null;
  return s;
}

// ── GET /auth/login ───────────────────────────────────────────────────────────
router.get('/login', (req: Request, res: Response) => {
  const next = safeNext(req.query.next);
  if (req.session.userId && req.session.emailVerified) return res.redirect(next ?? '/');
  res.render('login', { error: null, email: '', next });
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post(
  '/login',
  body('email').isEmail().normalizeEmail({ gmail_remove_dots: false }),
  body('password').notEmpty(),
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    const next = safeNext(req.body.next ?? req.query.next);
    if (!errors.isEmpty()) {
      return res.render('login', { error: 'Email o contraseña inválidos.', email: req.body.email ?? '', next });
    }

    const { email, password } = req.body as { email: string; password: string };

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      return res.render('login', { error: 'Email o contraseña incorrectos.', email, next });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.render('login', { error: 'Email o contraseña incorrectos.', email, next });
    }

    if (!user.emailVerified) {
      req.session.userId = user.id;
      req.session.userEmail = user.email;
      req.session.emailVerified = false;
      req.session.pendingNext = next ?? undefined;
      return req.session.save(() => res.redirect('/auth/verify-pending'));
    }

    req.session.userId = user.id;
    req.session.userEmail = user.email;
    req.session.emailVerified = true;
    req.session.save(() => res.redirect(next ?? '/'));
  },
);

// ── GET /auth/register ────────────────────────────────────────────────────────
router.get('/register', (req: Request, res: Response) => {
  const next = safeNext(req.query.next);
  if (req.session.userId && req.session.emailVerified) return res.redirect(next ?? '/');
  res.render('register', { error: null, email: '', next });
});

// ── POST /auth/register ───────────────────────────────────────────────────────
router.post(
  '/register',
  body('email').isEmail().normalizeEmail({ gmail_remove_dots: false }),
  body('password').isLength({ min: 8 }).withMessage('La contraseña debe tener al menos 8 caracteres.'),
  body('passwordConfirm').custom((val, { req }) => {
    if (val !== req.body.password) throw new Error('Las contraseñas no coinciden.');
    return true;
  }),
  async (req: Request, res: Response) => {
    // New accounts only through Google when PASSWORD_SIGNUP=off (the open form was flooded with bots).
    if (!passwordSignupEnabled()) {
      return res.status(403).render('register', {
        error: 'El registro con email y contraseña está cerrado. Usa «Continuar con Google».', email: '', next: safeNext(req.body.next ?? req.query.next),
      });
    }
    const errors = validationResult(req);
    const next = safeNext(req.body.next ?? req.query.next);
    if (!errors.isEmpty()) {
      return res.render('register', {
        error: errors.array()[0].msg,
        email: req.body.email ?? '',
        next,
      });
    }

    const { email, password } = req.body as { email: string; password: string };

    const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing) {
      return res.render('register', { error: 'Este email ya está registrado.', email, next });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const [user] = await db
      .insert(users)
      .values({ email, passwordHash, emailVerified: false })
      .returning();

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.insert(emailVerifications).values({ userId: user.id, token, expiresAt });

    const siteUrl = process.env.SITE_URL ?? 'http://localhost:3000';
    const verifyUrl = `${siteUrl}/auth/verify?token=${token}`;
    sendVerificationEmail({ to: email, verifyUrl }).catch(err =>
      console.error('[auth] sendVerificationEmail failed:', err),
    );

    req.session.userId = user.id;
    req.session.userEmail = user.email;
    req.session.emailVerified = false;
    req.session.pendingNext = next ?? undefined;
    req.session.save(() => res.redirect('/auth/verify-pending'));
  },
);

// ── GET /auth/verify-pending ──────────────────────────────────────────────────
router.get('/verify-pending', (req: Request, res: Response) => {
  if (!req.session.userId) return res.redirect('/auth/login');
  if (req.session.emailVerified) return res.redirect(req.session.pendingNext ?? '/');
  res.render('verify-pending', { email: req.session.userEmail ?? '' });
});

// ── POST /auth/resend-verification ───────────────────────────────────────────
router.post('/resend-verification', async (req: Request, res: Response) => {
  if (!req.session.userId) return res.redirect('/auth/login');

  const userId = req.session.userId;
  const email = req.session.userEmail!;

  // Delete old tokens for this user
  await db
    .delete(emailVerifications)
    .where(eq(emailVerifications.userId, userId));

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.insert(emailVerifications).values({ userId, token, expiresAt });

  const siteUrl = process.env.SITE_URL ?? 'http://localhost:3000';
  const verifyUrl = `${siteUrl}/auth/verify?token=${token}`;
  sendVerificationEmail({ to: email, verifyUrl }).catch(err =>
    console.error('[auth] resend sendVerificationEmail failed:', err),
  );

  res.render('verify-pending', { email, resent: true });
});

// ── GET /auth/verify?token=xxx ────────────────────────────────────────────────
router.get('/verify', async (req: Request, res: Response) => {
  const token = String(req.query.token ?? '').trim();
  if (!token) return res.redirect('/auth/login');

  const now = new Date();
  const [row] = await db
    .select()
    .from(emailVerifications)
    .where(and(eq(emailVerifications.token, token), gt(emailVerifications.expiresAt, now)))
    .limit(1);

  if (!row) {
    return res.render('error', {
      message: 'El enlace de verificación no es válido o ha expirado.',
      user: null,
    });
  }

  const [verifiedUser] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  await db.update(users).set({ emailVerified: true }).where(eq(users.id, row.userId));
  await db.delete(emailVerifications).where(eq(emailVerifications.userId, row.userId));

  sendWelcomeEmail({ to: verifiedUser.email }).catch(err =>
    console.error('[auth] sendWelcomeEmail failed:', err),
  );

  // Update session if this user is logged in
  let pendingNext: string | null = null;
  if (req.session.userId === row.userId) {
    req.session.emailVerified = true;
    pendingNext = safeNext(req.session.pendingNext);
    req.session.pendingNext = undefined;
    if (pendingNext) {
      return req.session.save(() => res.redirect(pendingNext!));
    }
  }

  res.render('login', {
    error: null,
    email: '',
    success: '¡Email verificado! Ya puedes iniciar sesión.',
    next: null,
  });
});

// ── GET /auth/forgot ──────────────────────────────────────────────────────────
router.get('/forgot', (req: Request, res: Response) => {
  if (req.session.userId && req.session.emailVerified) return res.redirect('/');
  res.render('forgot', { sent: false, error: null });
});

// ── POST /auth/forgot ─────────────────────────────────────────────────────────
router.post(
  '/forgot',
  body('email').isEmail().normalizeEmail({ gmail_remove_dots: false }),
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render('forgot', { sent: false, error: 'Introduce un email válido.' });
    }

    const { email } = req.body as { email: string };
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    // Always show success to avoid user enumeration
    if (user) {
      await db.delete(passwordResets).where(eq(passwordResets.userId, user.id));

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await db.insert(passwordResets).values({ userId: user.id, token, expiresAt });

      const siteUrl = process.env.SITE_URL ?? 'http://localhost:3000';
      const resetUrl = `${siteUrl}/auth/reset?token=${token}`;
      sendPasswordResetEmail({ to: email, resetUrl }).catch(err =>
        console.error('[auth] sendPasswordResetEmail failed:', err),
      );
    }

    res.render('forgot', { sent: true, error: null });
  },
);

// ── GET /auth/reset?token=xxx ─────────────────────────────────────────────────
router.get('/reset', async (req: Request, res: Response) => {
  const token = String(req.query.token ?? '').trim();
  if (!token) return res.redirect('/auth/forgot');

  const now = new Date();
  const [row] = await db
    .select()
    .from(passwordResets)
    .where(and(eq(passwordResets.token, token), gt(passwordResets.expiresAt, now)))
    .limit(1);

  if (!row) {
    return res.render('reset', { token: '', error: 'El enlace no es válido o ha expirado.', expired: true });
  }

  res.render('reset', { token, error: null, expired: false });
});

// ── POST /auth/reset ──────────────────────────────────────────────────────────
router.post(
  '/reset',
  body('password').isLength({ min: 8 }).withMessage('La contraseña debe tener al menos 8 caracteres.'),
  body('passwordConfirm').custom((val, { req }) => {
    if (val !== req.body.password) throw new Error('Las contraseñas no coinciden.');
    return true;
  }),
  async (req: Request, res: Response) => {
    const token = String(req.body.token ?? '').trim();
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render('reset', { token, error: errors.array()[0].msg, expired: false });
    }

    const now = new Date();
    const [row] = await db
      .select()
      .from(passwordResets)
      .where(and(eq(passwordResets.token, token), gt(passwordResets.expiresAt, now)))
      .limit(1);

    if (!row) {
      return res.render('reset', { token: '', error: 'El enlace no es válido o ha expirado.', expired: true });
    }

    const { password } = req.body as { password: string };
    const passwordHash = await bcrypt.hash(password, 12);

    await db.update(users).set({ passwordHash, passwordSet: true }).where(eq(users.id, row.userId));
    await db.delete(passwordResets).where(eq(passwordResets.userId, row.userId));

    res.render('login', {
      error: null,
      email: '',
      success: 'Contraseña actualizada. Ya puedes iniciar sesión.',
    });
  },
);

// ── Sign in with Google ───────────────────────────────────────────────────────
// GET /auth/google            -> sends the person to Google (state + nonce + PKCE kept in the session)
// GET /auth/google/callback   -> checks everything, finds/links/creates the account and logs in
const GOOGLE_FLOW_MAX_AGE_MS = 10 * 60 * 1000;
const googleError = (res: Response, msg: string, next: string | null = null) =>
  res.render('login', { error: msg, email: '', next });
const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

router.get('/google', (req: Request, res: Response) => {
  const cfg = googleConfig();
  if (!cfg) return res.redirect('/auth/login');
  const state = randomToken(), nonce = randomToken(), { verifier, challenge } = pkcePair();
  req.session.googleOAuth = { state, nonce, verifier, next: safeNext(req.query.next) ?? undefined, at: Date.now() };
  req.session.save(() => res.redirect(buildAuthUrl(cfg, { state, nonce, challenge })));
});

router.get('/google/callback', async (req: Request, res: Response) => {
  const cfg = googleConfig();
  if (!cfg) return res.redirect('/auth/login');
  const saved = req.session.googleOAuth;
  req.session.googleOAuth = undefined;                       // single use, whatever happens next
  const next = saved?.next ?? null;

  if (req.query.error) return googleError(res, 'Has cancelado el acceso con Google.', next);
  const code = String(req.query.code ?? ''), state = String(req.query.state ?? '');
  if (!saved || !code || !sameSecret(state, saved.state) || Date.now() - saved.at > GOOGLE_FLOW_MAX_AGE_MS) {
    return googleError(res, 'La sesión de acceso con Google ha caducado. Inténtalo de nuevo.', next);
  }

  try {
    const idToken = await exchangeCode(cfg, code, saved.verifier);
    const identity = await verifyIdToken(idToken, cfg, saved.nonce);
    const { user, outcome } = await resolveGoogleUser(identity);
    console.log(`[auth] Google login user=${user.id} outcome=${outcome}`);
    // New session id on login (prevents session fixation).
    req.session.regenerate((err) => {
      if (err) return googleError(res, 'No hemos podido iniciar sesión. Inténtalo de nuevo.', next);
      req.session.userId = user.id;
      req.session.userEmail = user.email;
      req.session.emailVerified = true;
      req.session.save(() => res.redirect(next ?? '/'));
    });
  } catch (err) {
    if (err instanceof GoogleEmailNotVerified) return googleError(res, 'Tu cuenta de Google no tiene el email verificado, así que no podemos usarla.', next);
    if (err instanceof GoogleAccountConflict) return googleError(res, 'Ese email ya está asociado a otra cuenta de Google.', next);
    console.error('[auth] Google login failed:', err instanceof Error ? err.message : err);
    return googleError(res, 'No hemos podido iniciar sesión con Google. Inténtalo de nuevo.', next);
  }
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
router.post('/logout', (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.redirect('/auth/login');
  });
});

export default router;
