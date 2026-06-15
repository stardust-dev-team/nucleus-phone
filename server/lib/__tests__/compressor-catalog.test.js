const {
  COMPRESSOR_CATALOG,
  assertDirectSalesAbove20Hp,
  assertEcommerceImpliesConfirmedPrice,
} = require('../compressor-catalog');

describe('assertDirectSalesAbove20Hp', () => {
  it('passes for the real production catalog', () => {
    // Smoke: if this throws, requiring the module already failed,
    // but assert explicitly so a future regression is signposted here.
    expect(() => assertDirectSalesAbove20Hp(COMPRESSOR_CATALOG)).not.toThrow();
  });

  it('allows hp=20 with salesChannel=ecommerce (boundary is hp>20)', () => {
    // The >20 HP hard rule does NOT cover 20 HP itself, so a 20 HP ecommerce
    // SKU must pass THIS guard. (The real JRS-20E is currently 'direct' while
    // its MSRP is pending — see assertEcommerceImpliesConfirmedPrice below —
    // but the boundary property under test is independent of that.) Lock the edge.
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

describe('assertEcommerceImpliesConfirmedPrice', () => {
  it('passes for the real production catalog', () => {
    // Smoke: requiring the module already runs this, but assert explicitly so
    // a regression is signposted here (this is the nucleus-phone-oqv guard).
    expect(() => assertEcommerceImpliesConfirmedPrice(COMPRESSOR_CATALOG)).not.toThrow();
  });

  it('the real JRS-20E is no longer the ecommerce+pending contradiction (oqv)', () => {
    // The bug: JRS-20E was salesChannel:'ecommerce' + pricingStatus:'pending'
    // + price:null simultaneously. Lock that it now resolves to a coherent
    // state — direct while pending (it flips back to ecommerce when CAS prices it).
    const jrs20e = COMPRESSOR_CATALOG.find((m) => m.model === 'JRS-20E');
    expect(jrs20e).toBeDefined();
    const contradictory =
      jrs20e.salesChannel === 'ecommerce' &&
      !(jrs20e.pricingStatus === 'confirmed' && jrs20e.price != null);
    expect(contradictory).toBe(false);
  });

  it('allows ecommerce when price is confirmed and non-null', () => {
    expect(() => assertEcommerceImpliesConfirmedPrice([
      { model: 'JRS-5E', salesChannel: 'ecommerce', pricingStatus: 'confirmed', price: 6995 },
    ])).not.toThrow();
  });

  it('allows direct entries regardless of pricing state', () => {
    // direct + pending (JRS-20E/25E today) and direct + quote_required are both fine.
    expect(() => assertEcommerceImpliesConfirmedPrice([
      { model: 'JRS-20E', salesChannel: 'direct', pricingStatus: 'pending', price: null },
      { model: 'JRS-50',  salesChannel: 'direct', pricingStatus: 'quote_required', price: null },
      { model: 'JRS-30',  salesChannel: 'direct', pricingStatus: 'confirmed', price: 19500 },
    ])).not.toThrow();
  });

  it('throws when an ecommerce entry has pricingStatus other than confirmed', () => {
    const fn = () => assertEcommerceImpliesConfirmedPrice([
      { model: 'JRS-20E', salesChannel: 'ecommerce', pricingStatus: 'pending', price: null },
    ]);
    expect(fn).toThrow();
    // Independent substring checks (not an order-coupled regex) so a future
    // reword survives as long as the model + offending state are surfaced.
    let err;
    try { fn(); } catch (e) { err = e; }
    expect(err.message).toContain('JRS-20E');
    expect(err.message).toContain('ecommerce');
    expect(err.message).toContain('pending');
  });

  it('throws when an ecommerce entry is confirmed but has a null price', () => {
    // 'confirmed' status with no actual MSRP is still a phantom listing.
    expect(() => assertEcommerceImpliesConfirmedPrice([
      { model: 'JRS-X', salesChannel: 'ecommerce', pricingStatus: 'confirmed', price: null },
    ])).toThrow(/contradiction/);
  });
});
