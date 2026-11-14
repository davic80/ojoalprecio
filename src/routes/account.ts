import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { body, validationResult } from 'express-validator';
import { db } from '../db/client';
import { users, alerts, products } from '../db/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';

const router = Router();

// ── GET /account ──────────────────────────────────────────────────────────────
/** AE tracks for the current user, joined with the catalog so the
 *  /account "Alertas AliExpress" section has everything in one shape. */
async function fetchUserAETracks(userId: number) {
  const r = await db.execute(sql`
    SELECT
      t.product_id           AS "productId",
      t.threshold_price::float AS "thresholdPrice",
      t.alert_enabled        AS "alertEnabled",
      t.notified_at          AS "notifiedAt",
      p.title                AS "title",
      p.image_url            AS "imageUrl",
      p.sale_price::float    AS "salePrice",
      p.currency             AS "currency",
      p.is_available         AS "isAvailable"
    FROM aliexpress_user_tracks t
    JOIN aliexpress_products p ON p.product_id = t.product_id
    WHERE t.user_id = ${userId}
    ORDER BY t.added_at DESC
  `);
  return r.rows as Array<{
    productId: string; thresholdPrice: number | null; alertEnabled: boolean;
    notifiedAt: Date | null; title: string; imageUrl: string | null;
    salePrice: number | null; currency: string; isAvailable: boolean;
  }>;
}

/** Does the person have a usable password, and is the account linked to Google? */
async function accountFlags(userId: number): Promise<{ hasPassword: boolean; googleLinked: boolean }> {
  const [u] = await db.select({ passwordSet: users.passwordSet, googleSub: users.googleSub }).from(users).where(eq(users.id, userId)).limit(1);
  return { hasPassword: u?.passwordSet ?? true, googleLinked: !!u?.googleSub };
}

router.get('/account', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  const userAlerts = await db
    .select({
      id: alerts.id,
      productId: alerts.productId,
      productName: products.name,
      productAsin: products.asin,
      alertType: alerts.alertType,
      thresholdPrice: alerts.thresholdPrice,
      percentageDrop: alerts.percentageDrop,
      notificationEmail: alerts.notificationEmail,
      notificationChannel: alerts.notificationChannel,
      isActive: alerts.isActive,
      notifiedAt: alerts.notifiedAt,
      createdAt: alerts.createdAt,
    })
    .from(alerts)
    .innerJoin(products, eq(products.id, alerts.productId))
    .where(eq(alerts.userId, userId))
    .orderBy(desc(alerts.createdAt));

  const aliexpressTracks = await fetchUserAETracks(userId);

  res.render('account', {
    user: { email: req.session.userEmail },
    alerts: userAlerts,
    aliexpressTracks,
    success: req.query.success ?? null,
    error: null,
    ...(await accountFlags(userId)),
  });
});

// ── POST /account/change-password ─────────────────────────────────────────────
router.post(
  '/account/change-password',
  requireAuth,
  body('currentPassword').notEmpty().withMessage('Introduce tu contraseña actual.'),
  body('newPassword').isLength({ min: 8 }).withMessage('La nueva contraseña debe tener al menos 8 caracteres.'),
  body('confirmPassword').custom((val, { req }) => {
    if (val !== req.body.newPassword) throw new Error('Las contraseñas no coinciden.');
    return true;
  }),
  async (req: Request, res: Response) => {
    const userId = req.session.userId!;

    const validationErrors = validationResult(req);

    const userAlerts = await db
      .select({
        id: alerts.id,
        productId: alerts.productId,
        productName: products.name,
        productAsin: products.asin,
        alertType: alerts.alertType,
        thresholdPrice: alerts.thresholdPrice,
        percentageDrop: alerts.percentageDrop,
        notificationEmail: alerts.notificationEmail,
        notificationChannel: alerts.notificationChannel,
        isActive: alerts.isActive,
        notifiedAt: alerts.notifiedAt,
        createdAt: alerts.createdAt,
      })
      .from(alerts)
      .innerJoin(products, eq(products.id, alerts.productId))
      .where(eq(alerts.userId, userId))
      .orderBy(desc(alerts.createdAt));

    const aliexpressTracks = await fetchUserAETracks(userId);

    if (!validationErrors.isEmpty()) {
      return res.render('account', {
        user: { email: req.session.userEmail },
        alerts: userAlerts,
        aliexpressTracks,
        success: null,
        error: validationErrors.array()[0].msg,
        ...(await accountFlags(userId)),
      });
    }

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const valid = await bcrypt.compare(req.body.currentPassword, user.passwordHash);
    if (!valid) {
      return res.render('account', {
        user: { email: req.session.userEmail },
        alerts: userAlerts,
        aliexpressTracks,
        success: null,
        error: 'La contraseña actual no es correcta.',
        ...(await accountFlags(userId)),
      });
    }

    const passwordHash = await bcrypt.hash(req.body.newPassword, 12);
    await db.update(users).set({ passwordHash }).where(eq(users.id, userId));

    res.redirect('/account?success=1');
  },
);

// ── POST /account/set-password — for accounts created with Google (no password yet) ──────────────
// The person is already authenticated (Google proved the email), so no "current password" is asked.
router.post(
  '/account/set-password',
  requireAuth,
  body('newPassword').isLength({ min: 8 }).withMessage('La contraseña debe tener al menos 8 caracteres.'),
  body('confirmPassword').custom((val, { req }) => {
    if (val !== req.body.newPassword) throw new Error('Las contraseñas no coinciden.');
    return true;
  }),
  async (req: Request, res: Response) => {
    const userId = req.session.userId!;
    const flags = await accountFlags(userId);
    const errors = validationResult(req);
    const fail = async (msg: string) => {
      const userAlerts = await db.select({
        id: alerts.id, productId: alerts.productId, productName: products.name, productAsin: products.asin,
        alertType: alerts.alertType, thresholdPrice: alerts.thresholdPrice, percentageDrop: alerts.percentageDrop,
        notificationEmail: alerts.notificationEmail, notificationChannel: alerts.notificationChannel,
        isActive: alerts.isActive, notifiedAt: alerts.notifiedAt, createdAt: alerts.createdAt,
      }).from(alerts).innerJoin(products, eq(products.id, alerts.productId)).where(eq(alerts.userId, userId)).orderBy(desc(alerts.createdAt));
      return res.status(400).render('account', {
        user: { email: req.session.userEmail }, alerts: userAlerts, aliexpressTracks: await fetchUserAETracks(userId),
        success: null, error: msg, ...flags,
      });
    };
    // An account that already has a password must use "change password" (it asks for the current one).
    if (flags.hasPassword) return fail('Esta cuenta ya tiene contraseña: usa «Cambiar contraseña».');
    if (!errors.isEmpty()) return fail(errors.array()[0].msg);
    const passwordHash = await bcrypt.hash(req.body.newPassword, 12);
    await db.update(users).set({ passwordHash, passwordSet: true }).where(eq(users.id, userId));
    res.redirect('/account?success=1');
  },
);

export default router;
