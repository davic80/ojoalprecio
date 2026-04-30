import nodemailer, { type Transporter } from 'nodemailer';

interface MailerConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

function getConfig(): MailerConfig {
  return {
    host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT ?? '587', 10),
    user: process.env.SMTP_USER ?? '',
    password: process.env.SMTP_PASSWORD ?? '',
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? '',
  };
}

function createTransporter(): Transporter {
  const cfg = getConfig();
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.password },
  });
}

export interface PriceAlertOptions {
  to: string;
  productName: string;
  productUrl: string;
  productId?: number | null;
  currentPrice: number;
  previousPrice?: number | null;
  thresholdPrice: number;
  imageUrl?: string | null;
  currency?: string;
}

export async function sendPriceAlert(opts: PriceAlertOptions): Promise<void> {
  const cfg = getConfig();
  if (!cfg.user || !cfg.password) {
    console.warn('[mailer] SMTP not configured, skipping email.');
    return;
  }

  const transporter = createTransporter();
  const currencySymbol = opts.currency === 'EUR' ? '€' : opts.currency ?? '€';
  const siteUrl = process.env.SITE_URL ?? 'http://localhost:3000';
  const historyUrl = opts.productId ? `${siteUrl}/products/${opts.productId}` : siteUrl;
  const accountUrl = `${siteUrl}/account`;

  const dropHtml = (() => {
    if (!opts.previousPrice || opts.previousPrice <= opts.currentPrice) return '';
    const absDrop = opts.previousPrice - opts.currentPrice;
    const pctDrop = (absDrop / opts.previousPrice) * 100;
    return `
      <div style="background:#f0fdf4; border:1px solid #86efac; border-radius:8px; padding:12px 16px; text-align:center; margin-bottom:20px; font-size:14px; color:#166534; font-weight:600;">
        ↓ −${pctDrop.toFixed(1)}% &nbsp;·&nbsp; −${absDrop.toFixed(2)} ${currencySymbol} vs precio anterior
      </div>`;
  })();

  const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Alerta de precio - OjoAlPrecio</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; margin: 0; padding: 20px;">
  <div style="max-width: 540px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.08);">

    <div style="background: #e63946; padding: 28px 32px; text-align: center;">
      <div style="font-size: 40px; margin-bottom: 8px;">👁</div>
      <h1 style="color: #fff; margin: 0; font-size: 22px; letter-spacing: -0.3px;">
        OjoAlPrecio — Alerta de precio
      </h1>
    </div>

    <div style="padding: 32px;">
      ${opts.imageUrl ? `<a href="${opts.productUrl}" style="display:block; text-decoration:none;"><img src="${opts.imageUrl}" alt="Producto" style="display:block;max-width:160px;height:auto;margin:0 auto 24px;border-radius:8px;"></a>` : ''}

      <h2 style="font-size: 16px; color: #333; margin: 0 0 8px;">
        <a href="${opts.productUrl}" style="color:#333; text-decoration:none;">${opts.productName}</a>
      </h2>

      <p style="color: #666; font-size: 14px; margin: 0 0 20px;">
        El precio ha bajado por debajo de tu umbral configurado.
      </p>

      ${dropHtml}

      <div style="display: flex; gap: 16px; margin-bottom: 28px;">
        <div style="flex:1; background:#fff5f5; border:1px solid #fecdd3; border-radius:8px; padding:16px; text-align:center;">
          <div style="font-size:12px; color:#999; text-transform:uppercase; letter-spacing:.5px; margin-bottom:4px;">Precio actual</div>
          <div style="font-size:28px; font-weight:700; color:#e63946;">${opts.currentPrice.toFixed(2)} ${currencySymbol}</div>
        </div>
        <div style="flex:1; background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:16px; text-align:center;">
          <div style="font-size:12px; color:#999; text-transform:uppercase; letter-spacing:.5px; margin-bottom:4px;">Tu umbral</div>
          <div style="font-size:28px; font-weight:700; color:#6b7280;">${opts.thresholdPrice.toFixed(2)} ${currencySymbol}</div>
        </div>
      </div>

      <a href="${opts.productUrl}"
         style="display:block; background:#e63946; color:#fff; text-decoration:none; text-align:center; padding:14px 24px; border-radius:8px; font-weight:600; font-size:15px; margin-bottom:12px;">
        Ver producto en Amazon ↗
      </a>

      <a href="${historyUrl}"
         style="display:block; background:#f9fafb; border:1px solid #e5e7eb; color:#374151; text-decoration:none; text-align:center; padding:12px 24px; border-radius:8px; font-weight:500; font-size:14px; margin-bottom:16px;">
        Ver historial en OjoAlPrecio
      </a>

      <div style="text-align:center;">
        <a href="${accountUrl}" style="color:#9ca3af; text-decoration:none; font-size:12px;">
          Gestionar mis alertas
        </a>
      </div>
    </div>

    <div style="background:#f9fafb; padding:16px 32px; text-align:center; font-size:12px; color:#9ca3af; border-top:1px solid #f0f0f0;">
      OjoAlPrecio — Seguimiento de precios en Amazon.es
    </div>
  </div>
</body>
</html>
  `.trim();

  await transporter.sendMail({
    from: `"OjoAlPrecio" <${cfg.from}>`,
    to: opts.to,
    subject: `👁 Precio bajado: ${opts.productName} — ${opts.currentPrice.toFixed(2)} ${currencySymbol}`,
    html,
  });

  console.log(`[mailer] Alert sent to ${opts.to} for "${opts.productName}" at ${opts.currentPrice}`);
}

export interface BackInStockOptions {
  to: string;
  productName: string;
  productUrl: string;
  currentPrice: number;
  imageUrl?: string | null;
  currency?: string;
}

export async function sendBackInStockAlert(opts: BackInStockOptions): Promise<void> {
  const cfg = getConfig();
  if (!cfg.user || !cfg.password) {
    console.warn('[mailer] SMTP not configured, skipping back-in-stock email.');
    return;
  }

  const transporter = createTransporter();
  const currencySymbol = opts.currency === 'EUR' ? '€' : opts.currency ?? '€';
  const siteUrl = process.env.SITE_URL ?? 'http://localhost:3000';

  const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vuelve a estar disponible - OjoAlPrecio</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; margin: 0; padding: 20px;">
  <div style="max-width: 540px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.08);">

    <div style="background: #2a9d8f; padding: 28px 32px; text-align: center;">
      <h1 style="color: #fff; margin: 0; font-size: 22px; letter-spacing: -0.3px;">
        OjoAlPrecio — ¡De vuelta en stock!
      </h1>
    </div>

    <div style="padding: 32px;">
      ${opts.imageUrl ? `<img src="${opts.imageUrl}" alt="Producto" style="display:block;max-width:160px;height:auto;margin:0 auto 24px;border-radius:8px;">` : ''}

      <h2 style="font-size: 16px; color: #333; margin: 0 0 8px;">${opts.productName}</h2>

      <p style="color: #666; font-size: 14px; margin: 0 0 24px;">
        Este producto que tenías en seguimiento vuelve a estar disponible en Amazon.es.
      </p>

      <div style="background:#f0fdf9; border:1px solid #6ee7d7; border-radius:8px; padding:20px; text-align:center; margin-bottom:28px;">
        <div style="font-size:12px; color:#999; text-transform:uppercase; letter-spacing:.5px; margin-bottom:4px;">Precio actual</div>
        <div style="font-size:32px; font-weight:700; color:#2a9d8f;">${opts.currentPrice.toFixed(2)} ${currencySymbol}</div>
      </div>

      <a href="${opts.productUrl}"
         style="display:block; background:#2a9d8f; color:#fff; text-decoration:none; text-align:center; padding:14px 24px; border-radius:8px; font-weight:600; font-size:15px; margin-bottom:16px;">
        Comprar en Amazon.es
      </a>

      <a href="${siteUrl}"
         style="display:block; color:#6b7280; text-decoration:none; text-align:center; font-size:13px;">
        Ver historial en OjoAlPrecio
      </a>
    </div>

    <div style="background:#f9fafb; padding:16px 32px; text-align:center; font-size:12px; color:#9ca3af; border-top:1px solid #f0f0f0;">
      OjoAlPrecio — Seguimiento de precios en Amazon.es
    </div>
  </div>
</body>
</html>
  `.trim();

  await transporter.sendMail({
    from: `"OjoAlPrecio" <${cfg.from}>`,
    to: opts.to,
    subject: `¡Vuelve a estar disponible! ${opts.productName} — ${opts.currentPrice.toFixed(2)} ${currencySymbol}`,
    html,
  });

  console.log(`[mailer] Back-in-stock alert sent to ${opts.to} for "${opts.productName}"`);
}

export interface VerificationEmailOptions {
  to: string;
  verifyUrl: string;
}

export async function sendVerificationEmail(opts: VerificationEmailOptions): Promise<void> {
  const cfg = getConfig();
  if (!cfg.user || !cfg.password) {
    console.warn('[mailer] SMTP not configured, skipping verification email.');
    return;
  }

  const transporter = createTransporter();

  const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verifica tu email - OjoAlPrecio</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; margin: 0; padding: 20px;">
  <div style="max-width: 540px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.08);">
    <div style="background: #e63946; padding: 28px 32px; text-align: center;">
      <h1 style="color: #fff; margin: 0; font-size: 22px; letter-spacing: -0.3px;">OjoAlPrecio — Verifica tu email</h1>
    </div>
    <div style="padding: 32px;">
      <p style="color: #333; font-size: 15px; margin: 0 0 24px;">
        Gracias por registrarte. Para activar tu cuenta haz clic en el botón siguiente:
      </p>
      <a href="${opts.verifyUrl}"
         style="display:block; background:#e63946; color:#fff; text-decoration:none; text-align:center; padding:14px 24px; border-radius:8px; font-weight:600; font-size:15px; margin-bottom:20px;">
        Verificar mi email
      </a>
      <p style="color:#9ca3af; font-size:12px; margin:0;">
        El enlace caduca en 24 horas. Si no te registraste en OjoAlPrecio, ignora este correo.
      </p>
    </div>
    <div style="background:#f9fafb; padding:16px 32px; text-align:center; font-size:12px; color:#9ca3af; border-top:1px solid #f0f0f0;">
      OjoAlPrecio — Seguimiento de precios en Amazon.es
    </div>
  </div>
</body>
</html>
  `.trim();

  await transporter.sendMail({
    from: `"OjoAlPrecio" <${cfg.from}>`,
    to: opts.to,
    subject: 'Verifica tu email en OjoAlPrecio',
    html,
  });

  console.log(`[mailer] Verification email sent to ${opts.to}`);
}

export interface PasswordResetEmailOptions {
  to: string;
  resetUrl: string;
}

export async function sendPasswordResetEmail(opts: PasswordResetEmailOptions): Promise<void> {
  const cfg = getConfig();
  if (!cfg.user || !cfg.password) {
    console.warn('[mailer] SMTP not configured, skipping password reset email.');
    return;
  }

  const transporter = createTransporter();

  const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Restablecer contraseña - OjoAlPrecio</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; margin: 0; padding: 20px;">
  <div style="max-width: 540px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.08);">
    <div style="background: #e63946; padding: 28px 32px; text-align: center;">
      <h1 style="color: #fff; margin: 0; font-size: 22px; letter-spacing: -0.3px;">OjoAlPrecio — Restablecer contraseña</h1>
    </div>
    <div style="padding: 32px;">
      <p style="color: #333; font-size: 15px; margin: 0 0 24px;">
        Recibimos una solicitud para restablecer la contraseña de tu cuenta. Haz clic en el botón para crear una nueva:
      </p>
      <a href="${opts.resetUrl}"
         style="display:block; background:#e63946; color:#fff; text-decoration:none; text-align:center; padding:14px 24px; border-radius:8px; font-weight:600; font-size:15px; margin-bottom:20px;">
        Restablecer contraseña
      </a>
      <p style="color:#9ca3af; font-size:12px; margin:0;">
        El enlace caduca en 1 hora. Si no solicitaste este cambio, ignora este correo — tu contraseña no cambiará.
      </p>
    </div>
    <div style="background:#f9fafb; padding:16px 32px; text-align:center; font-size:12px; color:#9ca3af; border-top:1px solid #f0f0f0;">
      OjoAlPrecio — Seguimiento de precios en Amazon.es
    </div>
  </div>
</body>
</html>
  `.trim();

  await transporter.sendMail({
    from: `"OjoAlPrecio" <${cfg.from}>`,
    to: opts.to,
    subject: 'Restablecer tu contraseña en OjoAlPrecio',
    html,
  });

  console.log(`[mailer] Password reset email sent to ${opts.to}`);
}

export interface WelcomeEmailOptions {
  to: string;
}

export async function sendWelcomeEmail(opts: WelcomeEmailOptions): Promise<void> {
  const cfg = getConfig();
  if (!cfg.user || !cfg.password) return;

  const transporter = createTransporter();
  const siteUrl = process.env.SITE_URL ?? 'http://localhost:3000';

  const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bienvenido a OjoAlPrecio</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; margin: 0; padding: 20px;">
  <div style="max-width: 540px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.08);">
    <div style="background: #e63946; padding: 28px 32px; text-align: center;">
      <div style="font-size: 48px; margin-bottom: 8px;">👁</div>
      <h1 style="color: #fff; margin: 0; font-size: 22px; letter-spacing: -0.3px;">¡Bienvenido a OjoAlPrecio!</h1>
    </div>
    <div style="padding: 32px;">
      <p style="color: #333; font-size: 15px; margin: 0 0 16px;">
        Tu cuenta está activa. Ya puedes empezar a seguir los precios de tus productos favoritos de Amazon.es.
      </p>
      <p style="color: #555; font-size: 14px; margin: 0 0 28px;">
        Pega la URL de cualquier artículo de Amazon.es y OjoAlPrecio registrará el precio cada hora. Cuando baje, te avisamos.
      </p>
      <a href="${siteUrl}"
         style="display:block; background:#e63946; color:#fff; text-decoration:none; text-align:center; padding:14px 24px; border-radius:8px; font-weight:600; font-size:15px; margin-bottom:24px;">
        Añadir mi primer producto →
      </a>
      <div style="background:#f9fafb; border-radius:8px; padding:16px 20px; font-size:13px; color:#555;">
        <strong style="display:block; margin-bottom:8px; color:#333;">¿Qué puedes hacer?</strong>
        <div style="margin-bottom:6px;">📊 Ver el historial de precios de cualquier producto</div>
        <div style="margin-bottom:6px;">🔔 Crear alertas para que te avisemos cuando baje el precio</div>
        <div>🛒 Seguir las ofertas del día en la página pública</div>
      </div>
    </div>
    <div style="background:#f9fafb; padding:16px 32px; text-align:center; font-size:12px; color:#9ca3af; border-top:1px solid #f0f0f0;">
      OjoAlPrecio — Seguimiento de precios en Amazon.es
    </div>
  </div>
</body>
</html>
  `.trim();

  await transporter.sendMail({
    from: `"OjoAlPrecio" <${cfg.from}>`,
    to: opts.to,
    subject: '¡Bienvenido a OjoAlPrecio! 👁',
    html,
  });

  console.log(`[mailer] Welcome email sent to ${opts.to}`);
}

export async function verifyMailer(): Promise<boolean> {
  const cfg = getConfig();
  if (!cfg.user || !cfg.password) return false;
  try {
    const t = createTransporter();
    await t.verify();
    return true;
  } catch {
    return false;
  }
}
