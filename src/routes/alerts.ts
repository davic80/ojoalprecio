import { Router, type Request, type Response } from 'express';
import { body, validationResult } from 'express-validator';
import { db } from '../db/client';
import { alerts, products, priceHistory } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';

const router = Router();

// ── POST /products/:id/alerts — Create alert ─────────────────────────────────
router.post(
  '/products/:id/alerts',
  requireAuth,
  body('notificationEmail').isEmail().normalizeEmail().withMessage('Email de notificación inválido.'),
  body('alertType').isIn(['price', 'percent', 'alltime_low', 'stock']).withMessage('Tipo de alerta inválido.'),
  body('thresholdPrice').if(body('alertType').equals('price'))
    .isFloat({ min: 0.01 }).withMessage('El precio umbral debe ser un número positivo.'),
  body('percentageDrop').if(body('alertType').equals('percent'))
    .isFloat({ min: 1, max: 99 }).withMessage('El porcentaje debe estar entre 1 y 99.'),
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

    const { alertType, thresholdPrice, percentageDrop, notificationEmail, notificationChannel, telegramChatId } =
      req.body as Record<string, string>;

    // For percent-based alerts, capture the current price as reference
    let referencePrice: string | undefined;
    if (alertType === 'percent') {
      const [latest] = await db
        .select({ price: priceHistory.price })
        .from(priceHistory)
        .where(eq(priceHistory.productId, productId))
        .orderBy(desc(priceHistory.scrapedAt))
        .limit(1);
      referencePrice = latest?.price ?? undefined;
    }

    await db.insert(alerts).values({
      productId,
      userId,
      alertType: alertType ?? 'price',
      thresholdPrice: alertType === 'price' ? String(parseFloat(thresholdPrice).toFixed(2)) : null,
      percentageDrop: alertType === 'percent' ? String(parseFloat(percentageDrop).toFixed(2)) : null,
      // stock alerts fire independently of price — no threshold needed
      referencePrice: referencePrice ?? null,
      notificationEmail,
      notificationChannel: notificationChannel ?? 'email',
      telegramChatId: telegramChatId || null,
      isActive: true,
    });

    if (req.headers['hx-request']) {
      res.setHeader('HX-Redirect', `/products/${productId}`);
      return res.status(200).send('');
    }
    res.status(201).json({ success: true });
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

  if (req.headers['hx-request']) return res.send('');
  res.json({ success: true });
});

// ── PATCH /alerts/:id/reset — Re-arm alert ────────────────────────────────────
router.patch('/alerts/:id/reset', requireAuth, async (req: Request, res: Response) => {
  const alertId = parseInt(String(req.params.id), 10);
  const userId = req.session.userId!;

  const [alert] = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.id, alertId), eq(alerts.userId, userId)))
    .limit(1);

  if (!alert) return res.status(404).json({ error: 'Alerta no encontrada.' });

  await db.update(alerts).set({ notifiedAt: null, isActive: true }).where(eq(alerts.id, alertId));

  if (req.headers['hx-request']) {
    res.setHeader('HX-Redirect', `/products/${alert.productId}`);
    return res.status(200).send('');
  }
  res.json({ success: true });
});

export default router;
