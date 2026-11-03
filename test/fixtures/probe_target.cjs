// Probe target for test/probes.test.ts: line 5 runs with `order` and `total` in scope.
exports.checkout = function checkout(order) {
  const total = order.items * 2;
  const secret = { get token() { throw new Error('getter ran'); } };
  return total + (secret ? 0 : 1);
};
