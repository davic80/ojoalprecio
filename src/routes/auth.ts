import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { body, validationResult } from 'express-validator';
import { db } from '../db/client';
import { users, emailVerifications, passwordResets } from '../db/schema';
import { eq, and, gt } from 'drizzle-orm';
import { sendVerificationEmail, sendPasswordResetEmail, sendWelcomeEmail } from '../mailer/index';

const router = Router();

// ── GET /auth/login ───────────────────────────────────────────────────────────
router.get('/login', (req: Request, res: Response) => {
  if (req.session.userId && req.session.emailVerified) return res.redirect('/');
  res.render('login', { error: null, email: '' });
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post(
  '/login',
  body('email').isEmail().normalizeEmail({ gmail_remove_dots: false }),
  body('password').notEmpty(),
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render('login', { error: 'Email o contraseña inválidos.', email: req.body.email ?? '' });
    }

    const { email, password } = req.body as { email: string; password: string };

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      return res.render('login', { error: 'Email o contraseña incorrectos.', email });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.render('login', { error: 'Email o contraseña incorrectos.', email });
    }

    if (!user.emailVerified) {
      req.session.userId = user.id;
      req.session.userEmail = user.email;
      req.session.emailVerified = false;
      return res.redirect('/auth/verify-pending');
    }

    req.session.userId = user.id;
    req.session.userEmail = user.email;
    req.session.emailVerified = true;
    res.redirect('/');
  },
);

// ── GET /auth/register ────────────────────────────────────────────────────────
router.get('/register', (req: Request, res: Response) => {
  if (req.session.userId && req.session.emailVerified) return res.redirect('/');
  res.render('register', { error: null, email: '' });
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
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render('register', {
        error: errors.array()[0].msg,
        email: req.body.email ?? '',
      });
    }

    const { email, password } = req.body as { email: string; password: string };

    const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing) {
      return res.render('register', { error: 'Este email ya está registrado.', email });
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
    res.redirect('/auth/verify-pending');
  },
);

// ── GET /auth/verify-pending ──────────────────────────────────────────────────
router.get('/verify-pending', (req: Request, res: Response) => {
  if (!req.session.userId) return res.redirect('/auth/login');
  if (req.session.emailVerified) return res.redirect('/');
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
  if (req.session.userId === row.userId) {
    req.session.emailVerified = true;
  }

  res.render('login', {
    error: null,
    email: '',
    success: '¡Email verificado! Ya puedes iniciar sesión.',
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

    await db.update(users).set({ passwordHash }).where(eq(users.id, row.userId));
    await db.delete(passwordResets).where(eq(passwordResets.userId, row.userId));

    res.render('login', {
      error: null,
      email: '',
      success: 'Contraseña actualizada. Ya puedes iniciar sesión.',
    });
  },
);

// ── POST /auth/logout ─────────────────────────────────────────────────────────
router.post('/logout', (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.redirect('/auth/login');
  });
});

export default router;
