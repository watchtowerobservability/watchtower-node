import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test('./next has edge-light, worker and browser conditions before import/require, on a stub with no node: imports', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
  const keys = Object.keys(pkg.exports['./next']);
  for (const k of ['edge-light', 'worker', 'browser']) {
    expect(keys.indexOf(k)).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf(k)).toBeLessThan(keys.indexOf('import'));
    expect(pkg.exports['./next'][k].default).toContain('next-edge');
  }
  expect(readFileSync(join(__dirname, '../src/integrations/next-edge.ts'), 'utf8')).not.toMatch(/node:|^\s*import /m);
});
