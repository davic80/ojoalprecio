import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// What runs in production is the code compiled by `tsc` to CommonJS, where imports are NOT hoisted the way they
// are under vitest/tsx. A `const x = importedFn(...)` placed above its import crashed the app on 2026-11-16
// ("Cannot access 'util_2' before initialization"): every unit test passed, the container crash-looped.
// So: compile for real and load the modules the way Node does.
describe('the compiled code loads (production runs the tsc output, not the TypeScript)', () => {
  it('every runtime module can be required after compiling', { timeout: 180_000 }, () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ojoalprecio-build-'));
    const root = path.resolve(__dirname, '..');
    try {
      execFileSync('npx', ['tsc', '-p', root, '--outDir', out, '--noEmit', 'false'], { cwd: root, stdio: 'pipe' });
      const mods = ['scraper/util', 'scraper/amazon', 'scraper/service', 'scraper/remote', 'scraper/wire', 'scheduler/queue', 'scheduler/index', 'server'];
      const script = mods.map(m => `require(${JSON.stringify(path.join(out, m))});`).join('') + 'process.exit(0);';
      execFileSync(process.execPath, ['-e', script], {
        cwd: root, stdio: 'pipe', timeout: 60_000,
        env: { ...process.env, NODE_PATH: path.join(root, 'node_modules'), DATABASE_URL: 'postgres://u:p@127.0.0.1:1/none', SESSION_SECRET: 'x'.repeat(32) },
      });
    } catch (e: any) {
      expect.fail(`compiled code does not load:\n${String(e.stderr ?? e.stdout ?? e.message).split('\n').slice(0, 12).join('\n')}`);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});
