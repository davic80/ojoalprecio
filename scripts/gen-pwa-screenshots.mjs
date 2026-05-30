#!/usr/bin/env node
/**
 * Capture real screenshots of /m at a mobile and a desktop viewport so the
 * Chrome PWA install prompt can show them ("Richer Install UI"). Hits the
 * URL set in PWA_SCREENSHOT_URL (defaults to https://ojoalprecio.com/m) so
 * the captures reflect the live app, not a local dev mockup.
 *
 *   npm run pwa:screenshots
 *
 * The two outputs land in public/screenshots/ and are referenced from
 * public/manifest.webmanifest. Re-run whenever the /m layout changes.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT       = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR    = path.join(ROOT, 'public', 'screenshots');
const TARGET_URL = process.env.PWA_SCREENSHOT_URL ?? 'https://ojoalprecio.com/m';

await mkdir(OUT_DIR, { recursive: true });

// Two captures, one per form_factor required by the spec:
//   mobile   → no form_factor (matches phones/tablets in the prompt)
//   wide     → form_factor: wide (matches desktop)
const SHOTS = [
  { name: 'mobile.png',  width:  390, height:  844, deviceScaleFactor: 2 },
  { name: 'desktop.png', width: 1280, height:  800, deviceScaleFactor: 1 },
];

const browser = await chromium.launch();
try {
  for (const s of SHOTS) {
    const ctx = await browser.newContext({
      viewport: { width: s.width, height: s.height },
      deviceScaleFactor: s.deviceScaleFactor,
    });
    const page = await ctx.newPage();
    await page.goto(TARGET_URL, { waitUntil: 'networkidle' });
    // Hide cookie banners or notifications if any exist — defensive, no-op
    // when those elements aren't present.
    await page.addStyleTag({ content: '.cookie-banner, .toast { display: none !important; }' });
    const outPath = path.join(OUT_DIR, s.name);
    await page.screenshot({ path: outPath, fullPage: false });
    await ctx.close();
    console.log(`✓ ${path.relative(ROOT, outPath)} (${s.width * s.deviceScaleFactor}×${s.height * s.deviceScaleFactor})`);
  }
} finally {
  await browser.close();
}
console.log('\nUpdate manifest screenshots entries if dimensions changed.');
