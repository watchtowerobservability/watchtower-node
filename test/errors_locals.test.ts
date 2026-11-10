import { test, expect } from 'vitest';
import { localsAttribute } from '../src/errors.js';

test('locals attribute names the throwing frame and masks secrets', () => {
  const e = new Error('boom');
  const raw = localsAttribute(e, { orderId: 42, password: 'hunter2', big: 'x'.repeat(500) });
  const [frame] = JSON.parse(raw!);
  expect(frame.lineno).toBeGreaterThan(0);
  expect(frame.vars.orderId).toBe('42');
  expect(frame.vars.password).toBe('[Filtered]');
  expect(frame.vars.big.length).toBe(120);
  expect(raw).not.toContain('hunter2');
});

test('no locals, no attribute', () => {
  expect(localsAttribute(new Error('x'), {})).toBeUndefined();
});
