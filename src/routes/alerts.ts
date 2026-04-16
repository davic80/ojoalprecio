import { Router, type Request, type Response } from 'express';
import { body, validationResult } from 'express-validator';
import { db } from '../db/client';
import { alerts, products } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';

const router = Router();

// ── GET /products/:id/alerts — List alerts for a product ─────────────────────
router.get('/products/:id/alerts', requireAuth, async (req: Request, res: Response) => {
  const productId = parseInt(String(req.params.id), 10);
  const userId = req.session.userId!;

  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.userId, userId)))
    .limit(1);

  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });

  const rows = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.productId, productId), eq(alerts.userId, userId)));

  res.json({ alerts: rows });
});

// ── POST /products/:id/alerts — Create alert ─────────────────────────────────
router.post(
  '/products/:id/alerts',
  requireAuth,
  body('thresholdPrice')
    .isFloat({ min: 0.01 })
    .withMessage('El precio umbral debe ser un número positivo.'),
  body('notificationEmail')
    .isEmail()
    .normalizeEmail()
    .withMessage('Email de notificación inválido.'),
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const productId = parseInt(String(req.params.id), 10);
    const userId = req.session.userId!;

    const [product] = await db
      .select()
      .from(products)
      .where(and(eq(products.id, productId), eq(products.userId, userId)))
      .limit(1);

    if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });

    const { thresholdPrice, notificationEmail } = req.body as {
      thresholdPrice: string;
      notificationEmail: string;
    };

    const [alert] = await db
      .insert(alerts)
      .values({
        productId,
        userId,
        thresholdPrice: String(parseFloat(thresholdPrice).toFixed(2)),
        notificationEmail,
        isActive: true,
      })
      .returning();

    if (req.headers['hx-request']) {
      return res.redirect(`/products/${productId}`);
    }
    res.status(201).json({ success: true, alert });
  },
);

// ── DELETE /alerts/:id — Remove alert ────────────────────────────────────────
router.delete('/alerts/:id', requireAuth, async (req: Request, res: Response) => {
  const alertId = parseInt(String(req.params.id), 10);
  const userId = req.session.userId!;

  const [alert] = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.id, alertId), eq(alerts.userId, userId)))
    .limit(1);

  if (!alert) return res.status(404).json({ error: 'Alerta no encontrada.' });

  await db.delete(alerts).where(eq(alerts.id, alertId));

  if (req.headers['hx-request']) {
    return res.send('');
  }
  res.json({ success: true });
});

// ── PATCH /alerts/:id/reset — Re-arm alert (allow another notification) ───────
router.patch('/alerts/:id/reset', requireAuth, async (req: Request, res: Response) => {
  const alertId = parseInt(String(req.params.id), 10);
  const userId = req.session.userId!;

  const [alert] = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.id, alertId), eq(alerts.userId, userId)))
    .limit(1);

  if (!alert) return res.status(404).json({ error: 'Alerta no encontrada.' });

  await db
    .update(alerts)
    .set({ notifiedAt: null, isActive: true })
    .where(eq(alerts.id, alertId));

  if (req.headers['hx-request']) {
    return res.redirect(`/products/${alert.productId}`);
  }
  res.json({ success: true });
});

export default router;
