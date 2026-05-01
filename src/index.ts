import 'dotenv/config';

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const _log = console.log.bind(console);
const _err = console.error.bind(console);
console.log   = (...a) => _log(`[${ts()}]`, ...a);
console.error = (...a) => _err(`[${ts()}]`, ...a);
console.warn  = (...a) => _err(`[${ts()}]`, ...a);

import { execSync } from 'child_process';
import { createApp } from './server';
import { pool } from './db/client';
import { migrate } from './db/migrate';
import { startScheduler } from './scheduler';

// Kill any leftover Chromium processes from previous runs
try {
  execSync('pkill -f chromium || true', { stdio: 'ignore' });
  console.log('[startup] Cleaned up leftover Chromium processes.');
} catch { /* ignore */ }

const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function main() {
  // Wait for PostgreSQL to be ready (retries for Docker startup order)
  let retries = 10;
  while (retries > 0) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch {
      retries--;
      if (retries === 0) {
        console.error('[startup] Cannot connect to PostgreSQL after retries. Exiting.');
        process.exit(1);
      }
      console.log(`[startup] Waiting for PostgreSQL… (${retries} retries left)`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  console.log('[startup] PostgreSQL connected.');

  await migrate();

  const app = createApp();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[startup] OjoAlPrecio running on http://0.0.0.0:${PORT}`);
    console.log(`[startup] Version: ${process.env.APP_VERSION ?? 'dev'}`);
    console.log(`[startup] Commit:  ${process.env.GIT_COMMIT ?? 'local'}`);
  });

  startScheduler();
}

main().catch((err) => {
  console.error('[startup] Fatal error:', err);
  process.exit(1);
});

function shutdown(signal: string) {
  console.log(`[startup] ${signal} received — cleaning up Chromium and exiting.`);
  try { execSync('pkill -f chromium || true', { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
