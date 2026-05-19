import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import type { TestProject } from 'vitest/node';

let container: StartedPostgreSqlContainer | null = null;

export default async function setup({ provide }: TestProject) {
  // Escape hatch for pure-logic test runs (categorize/sale-logic/util): skip
  // the container + migration cycle. `npm run test:unit` sets this.
  if (process.env.SKIP_DB_SETUP === '1') {
    provide('databaseUrl', '');
    return async () => { /* nothing started */ };
  }

  const uri = await acquireDatabaseUri();
  await applyMigrations(uri);
  provide('databaseUrl', uri);

  return async () => {
    if (container) await container.stop({ remove: true, removeVolumes: true });
  };
}

async function acquireDatabaseUri(): Promise<string> {
  // Honour an externally-provided DB (CI service container, local
  // docker-compose…) so devs can opt out of testcontainers when they
  // already have one running.
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;

  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('ojoalprecio_test')
    .withUsername('test')
    .withPassword('test')
    .start();
  return container.getConnectionUri();
}

/**
 * Runs the production migration set against the fresh test DB. We use an
 * ad-hoc Pool here on purpose: importing src/db/client at this point would
 * lock in its singleton against whatever DATABASE_URL was set at module-load
 * time, and globalSetup runs in a separate process where env vars don't
 * propagate to test workers anyway.
 */
async function applyMigrations(uri: string): Promise<void> {
  const pool = new Pool({ connectionString: uri });
  try {
    const { migrate } = await import('../../src/db/migrate');
    await migrate(pool);
  } finally {
    await pool.end();
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
