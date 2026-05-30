#!/usr/bin/env node
/**
 * Generate every PNG raster the PWA install flow needs from the SVG sources
 * in public/icons/. Idempotent — safe to re-run after editing the SVGs.
 *
 *   • icon-192.png / icon-512.png  → Android manifest icons (any purpose)
 *   • icon-512-maskable.png        → Android maskable icon
 *   • apple-touch-icon.png         → iOS home-screen icon (180×180)
 *   • splash/<size>.png            → iOS launch screens
 *
 * iOS splash sizes cover the most-shipped iPhone resolutions. iPad sizes
 * skipped for V1; native iPad PWA is rare enough that the default white
 * splash is acceptable until someone asks.
 */
import sharp from 'sharp';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT       = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ICONS_DIR  = path.join(ROOT, 'public', 'icons');
const SPLASH_DIR = path.join(ROOT, 'public', 'splash');
const BG         = { r: 0xb5, g: 0x38, b: 0x47, alpha: 1 };  // brand red

async function renderIcon(svgPath, outPath, size) {
  const svg = await readFile(svgPath);
  await sharp(svg, { density: 384 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  console.log(`✓ ${path.relative(ROOT, outPath)} (${size}×${size})`);
}

async function renderSplash(svgPath, outPath, width, height) {
  const svg = await readFile(svgPath);
  // Icon takes 40% of the shorter dimension, centered on brand background.
  const iconSize = Math.round(Math.min(width, height) * 0.40);
  const iconBuf = await sharp(svg, { density: 384 })
    .resize(iconSize, iconSize)
    .png()
    .toBuffer();

  await sharp({
    create: { width, height, channels: 4, background: BG },
  })
    .composite([{ input: iconBuf, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  console.log(`✓ ${path.relative(ROOT, outPath)} (${width}×${height})`);
}

await mkdir(ICONS_DIR, { recursive: true });
await mkdir(SPLASH_DIR, { recursive: true });

const SOURCE          = path.join(ICONS_DIR, 'icon-source.svg');
const SOURCE_MASKABLE = path.join(ICONS_DIR, 'icon-source-maskable.svg');

// ── Android / generic PWA icons ────────────────────────────────────────────
await renderIcon(SOURCE,          path.join(ICONS_DIR, 'icon-192.png'),          192);
await renderIcon(SOURCE,          path.join(ICONS_DIR, 'icon-512.png'),          512);
await renderIcon(SOURCE_MASKABLE, path.join(ICONS_DIR, 'icon-512-maskable.png'), 512);

// ── iOS home-screen icon ───────────────────────────────────────────────────
await renderIcon(SOURCE, path.join(ROOT, 'public', 'apple-touch-icon.png'), 180);

// ── iOS launch screens ─────────────────────────────────────────────────────
// Sizes match the device's CSS @media (device-width × device-height) in
// physical pixels. Apple is strict about the dimensions; the manifest
// <link> rel="apple-touch-startup-image" media query has to match exactly.
const SPLASHES = [
  // iPhone 15 / 14 / 13 / 12 (standard 6.1")
  { name: 'iphone-1170x2532.png', w: 1170, h: 2532 },
  // iPhone 15 Pro / 14 Pro (6.1" Dynamic Island)
  { name: 'iphone-1179x2556.png', w: 1179, h: 2556 },
  // iPhone 15 Pro Max / 14 Pro Max
  { name: 'iphone-1290x2796.png', w: 1290, h: 2796 },
  // iPhone 12/13 Pro Max
  { name: 'iphone-1284x2778.png', w: 1284, h: 2778 },
  // iPhone 11 Pro Max / XS Max
  { name: 'iphone-1242x2688.png', w: 1242, h: 2688 },
  // iPhone SE (3rd gen) / 8
  { name: 'iphone-750x1334.png',  w:  750, h: 1334 },
];

for (const s of SPLASHES) {
  await renderSplash(SOURCE, path.join(SPLASH_DIR, s.name), s.w, s.h);
}

console.log('\nAll PWA assets regenerated. Commit public/icons/ + public/splash/.');
