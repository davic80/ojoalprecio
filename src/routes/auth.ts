import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { body, validationResult } from 'express-validator';
import { db } from '../db/client';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';

const router = Router();

// ── GET /auth/login ───────────────────────────────────────────────────────────
router.get('/login', (req: Request, res: Response) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login', { error: null, email: '' });
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post(
  '/login',
  body('email').isEmail().normalizeEmail(),
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

    req.session.userId = user.id;
    req.session.userEmail = user.email;
    res.redirect('/');
  },
);

// ── GET /auth/register ────────────────────────────────────────────────────────
router.get('/register', (req: Request, res: Response) => {
  if (req.session.userId) return res.redirect('/');
  res.render('register', { error: null, email: '' });
});

// ── POST /auth/register ───────────────────────────────────────────────────────
router.post(
  '/register',
  body('email').isEmail().normalizeEmail(),
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
    const [user] = await db.insert(users).values({ email, passwordHash }).returning();

    req.session.userId = user.id;
    req.session.userEmail = user.email;
    res.redirect('/');
  },
);

// ── POST /auth/logout ─────────────────────────────────────────────────────────
router.post('/logout', (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.redirect('/auth/login');
  });
});

export default router;
