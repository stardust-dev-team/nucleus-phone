const {
  COMPRESSOR_CATALOG,
  assertDirectSalesAbove20Hp,
} = require('../compressor-catalog');

describe('assertDirectSalesAbove20Hp', () => {
  it('passes for the real production catalog', () => {
    // Smoke: if this throws, requiring the module already failed,
    // but assert explicitly so a future regression is signposted here.
    expect(() => assertDirectSalesAbove20Hp(COMPRESSOR_CATALOG)).not.toThrow();
  });

  it('allows hp=20 with salesChannel=ecommerce (boundary is hp>20)', () => {
    // JRS-20E is intentionally still ecommerce — the >20 HP hard rule
    // does NOT cover 20 HP itself. Lock that edge.
    expect(() => assertDirectSalesAbove20Hp([
      { model: 'JRS-20E', hp: 20, salesChannel: 'ecommerce' },
    ])).not.toThrow();
  });

  it('allows >20 HP entries when salesChannel=direct', () => {
    expect(() => assertDirectSalesAbove20Hp([
      { model: 'JRS-30', hp: 30, salesChannel: 'direct' },
      { model: 'JVSD-100', hp: 100, salesChannel: 'direct' },
    ])).not.toThrow();
  });

  it('throws when an entry has hp>20 && salesChannel=ecommerce', () => {
    const fn = () => assertDirectSalesAbove20Hp([
      { model: 'JRS-25E', hp: 25, salesChannel: 'ecommerce' },
    ]);
    expect(fn).toThrow();
    // Independent substring checks rather than an order-coupled regex —
    // a future message rewording shouldn't break this test as long as
    // the model, HP, and channel are still surfaced.
    let err;
    try { fn(); } catch (e) { err = e; }
    expect(err.message).toContain('JRS-25E');
    expect(err.message).toContain('25');
    expect(err.message).toContain('ecommerce');
  });

  it('throws on typo or unknown channel values at hp>20', () => {
    // The whole reason the predicate is `!== 'direct'` not `=== 'ecommerce'`:
    // an edit that introduces a typo or a new channel name must still trip
    // the guard. Without this, a leak ships silently.
    expect(() => assertDirectSalesAbove20Hp([
      { model: 'JRS-30X', hp: 30, salesChannel: 'web' },
    ])).toThrow(/hard-rule violation/);
    expect(() => assertDirectSalesAbove20Hp([
      { model: 'JRS-30Y', hp: 30, salesChannel: 'Ecommerce' },
    ])).toThrow(/hard-rule violation/);
  });

  it('error message references feedback_cas_pricing_boundary.md', () => {
    // Future maintainer needs the policy pointer, not just the symptom.
    expect(() => assertDirectSalesAbove20Hp([
      { model: 'JRS-25E', hp: 25, salesChannel: 'ecommerce' },
    ])).toThrow(/feedback_cas_pricing_boundary\.md/);
  });
});
