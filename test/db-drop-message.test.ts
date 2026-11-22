import { expect, test, vi } from 'vitest';
import { context } from '@opentelemetry/api';
import { startDbSpan } from '../src/integrations/db.js';

test('the first query dropped for lack of a parent span prints one line; later drops stay quiet', () => {
  process.env.WATCHTOWER_DB_REQUIRE_PARENT = '1';
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  startDbSpan({ system: 'sqlite', sql: 'SELECT 1' }, undefined, context.active());
  startDbSpan({ system: 'sqlite', sql: 'SELECT 2' }, undefined, context.active());
  expect(info.mock.calls.map((c) => c[0])).toEqual(['[watchtower] dropped a DB query outside any span (requireParent on; WATCHTOWER_DB_REQUIRE_PARENT=0 to keep them)']);
  delete process.env.WATCHTOWER_DB_REQUIRE_PARENT;
});
