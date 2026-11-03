// Probe target for the span probe tests: `charge` is wrapped by a span probe; line 6 is where a
// span_decoration probe tags the active span with `plan`.
exports.charge = function charge(user, amount) {
  if (amount < 0) throw new Error('negative');
  const plan = user.plan;
  return plan === 'pro' ? amount * 2 : amount;
};
exports.later = async function later(n) {
  return n + 1;
};
