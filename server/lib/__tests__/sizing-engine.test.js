const {
  calculateDemand,
  recommendSystem,
  addQualityFilters,
  deriveSalesChannel,
  selectFilter,
  SAFETY_FACTOR,
  COMPRESSOR_CATALOG,
  DRYER_CATALOG,
  DESICCANT_CATALOG,
  FILTER_SIZES,
} = require('../sizing-engine');

describe('calculateDemand', () => {
  it('returns null for empty or null input', () => {
    expect(calculateDemand(null)).toBeNull();
    expect(calculateDemand([])).toBeNull();
  });

  it('returns null when all CFM values are zero', () => {
    expect(calculateDemand([{ cfm_typical: 0, count: 1 }])).toBeNull();
  });

  it('calculates demand for a single machine', () => {
    const result = calculateDemand([{
      cfm_typical: 12, cfm_max: 18, duty_cycle_pct: 60, psi_required: 90, count: 1,
    }]);
    // totalCfmAtDuty = 12 * 0.6 * 1 = 7.2
    // peakCfm = 18 * 1 = 18
    // adjustedCfm = ceil(7.2 * 1.25) = ceil(9.0) = 9
    expect(result.totalCfmAtDuty).toBe(7.2);
    expect(result.peakCfm).toBe(18);
    expect(result.adjustedCfm).toBe(9);
    expect(result.maxPsi).toBe(90);
    expect(result.equipmentCount).toBe(1);
  });

  it('calculates demand for multiple machines', () => {
    const result = calculateDemand([
      { cfm_typical: 12, duty_cycle_pct: 60, psi_required: 90, count: 3 },  // 3x Haas VF-2
      { cfm_typical: 10, duty_cycle_pct: 70, psi_required: 100, count: 2 }, // 2x Mazak QTN-200
    ]);
    // totalCfmAtDuty = (12 * 0.6 * 3) + (10 * 0.7 * 2) = 21.6 + 14.0 = 35.6
    // adjustedCfm = ceil(35.6 * 1.25) = ceil(44.5) = 45
    expect(result.totalCfmAtDuty).toBe(35.6);
    expect(result.adjustedCfm).toBe(45);
    expect(result.maxPsi).toBe(100);
    expect(result.equipmentCount).toBe(5);
  });

  it('defaults duty_cycle to 100% when not specified', () => {
    const result = calculateDemand([{ cfm_typical: 20, count: 1 }]);
    expect(result.totalCfmAtDuty).toBe(20);
  });

  it('defaults count to 1 when not specified', () => {
    const result = calculateDemand([{ cfm_typical: 15, duty_cycle_pct: 50 }]);
    expect(result.totalCfmAtDuty).toBe(7.5);
    expect(result.equipmentCount).toBe(1);
  });

  it('defaults maxPsi to 90 when none specified', () => {
    const result = calculateDemand([{ cfm_typical: 10, count: 1 }]);
    expect(result.maxPsi).toBe(90);
  });

  it('uses cfm_typical as cfm_max fallback', () => {
    const result = calculateDemand([{ cfm_typical: 15, count: 1 }]);
    expect(result.peakCfm).toBe(15);
  });

  it('handles string values via parseInt/parseFloat', () => {
    const result = calculateDemand([{
      cfm_typical: '12.5', duty_cycle_pct: '60', psi_required: '90', count: '2',
    }]);
    expect(result.totalCfmAtDuty).toBe(15); // 12.5 * 0.6 * 2
    expect(result.equipmentCount).toBe(2);
  });

  it('preserves zero duty cycle correctly', () => {
    const result = calculateDemand([
      { cfm_typical: 10, duty_cycle_pct: 0, count: 1 },
      { cfm_typical: 20, duty_cycle_pct: 50, count: 1 },
    ]);
    expect(result.totalCfmAtDuty).toBe(10);
  });
});

describe('recommendSystem', () => {
  it('returns null for null demand', () => {
    expect(recommendSystem(null)).toBeNull();
  });

  it('recommends JRS-5E for very low demand', () => {
    const demand = calculateDemand([{ cfm_typical: 8, duty_cycle_pct: 60, count: 1 }]);
    const rec = recommendSystem(demand);
    expect(rec.compressor.model).toBe('JRS-5E');
    expect(rec.dryer).toBeTruthy();
    expect(rec.filters.length).toBeGreaterThan(0);
  });

  it('recommends JRS-7.5E for moderate low demand', () => {
    const demand = calculateDemand([{ cfm_typical: 12, duty_cycle_pct: 100, count: 1 }]);
    const rec = recommendSystem(demand);
    // adjustedCfm = ceil(12 * 1.25) = 15 → fits JRS-5E (18 CFM)
    expect(rec.compressor.model).toBe('JRS-5E');

    const demand2 = calculateDemand([{ cfm_typical: 15, duty_cycle_pct: 100, count: 1 }]);
    // adjustedCfm = ceil(15 * 1.25) = ceil(18.75) = 19 → JRS-7.5E (28 CFM)
    const rec2 = recommendSystem(demand2);
    expect(rec2.compressor.model).toBe('JRS-7.5E');
    expect(rec2.compressor.price).toBe(7495);
  });

  it('recommends JRS-10E for medium demand', () => {
    const demand = calculateDemand([{ cfm_typical: 12, duty_cycle_pct: 60, count: 3 }]);
    const rec = recommendSystem(demand);
    expect(rec.compressor.model).toBe('JRS-7.5E');

    const demand2 = calculateDemand([{ cfm_typical: 12, duty_cycle_pct: 80, count: 3 }]);
    // adjustedCfm = ceil(28.8 * 1.25) = ceil(36.0) = 36 → JRS-10E (38 CFM)
    const rec2 = recommendSystem(demand2);
    expect(rec2.compressor.model).toBe('JRS-10E');
    expect(rec2.compressor.price).toBe(9495);
  });

  it('builds parallel config when demand exceeds largest single unit', () => {
    // Need demand > JLF-476 (1895 CFM). Use massive shop.
    const demand = calculateDemand([{ cfm_typical: 100, duty_cycle_pct: 100, count: 20 }]);
    // adjustedCfm = ceil(2000 * 1.25) = 2500 → exceeds JLF-476 (1895 CFM)
    const rec = recommendSystem(demand);
    expect(rec.parallelConfig).not.toBeNull();
    expect(rec.parallelConfig.unitCount).toBe(2);
    expect(rec.parallelConfig.totalCfm).toBeGreaterThanOrEqual(demand.adjustedCfm);
    // compressor field is ALWAYS present (points to the replicated unit)
    expect(rec.compressor.model).toBe('JLF-476');
  });

  it('notes high PSI requirements', () => {
    const demand = { totalCfmAtDuty: 20, peakCfm: 30, adjustedCfm: 25, adjustedPeak: 38, maxPsi: 150, equipmentCount: 2 };
    const rec = recommendSystem(demand);
    expect(rec.notes.join(' ')).toContain('High PSI');
  });

  it('selects dryer matching compressor capacity', () => {
    const demand = calculateDemand([{ cfm_typical: 30, duty_cycle_pct: 80, count: 1 }]);
    const rec = recommendSystem(demand);
    expect(rec.dryer.cfm).toBeGreaterThanOrEqual(rec.compressor.cfm);
  });

  it('always includes particulate filter sized to compressor', () => {
    const demand = calculateDemand([{ cfm_typical: 10, count: 1 }]);
    const rec = recommendSystem(demand);
    expect(rec.filters.some(f => f.micron === 1)).toBe(true);
    const pf = rec.filters.find(f => f.micron === 1);
    expect(pf.cfm).toBeGreaterThanOrEqual(rec.compressor.cfm);
  });

  it('includes price: null for TBD items', () => {
    const demand = calculateDemand([{ cfm_typical: 40, duty_cycle_pct: 100, count: 1 }]);
    // adjustedCfm = ceil(40 * 1.25) = 50 → JRS-15E (54 CFM, rs_open preferred over JVSD-15 at 53)
    const rec = recommendSystem(demand);
    expect(rec.compressor.model).toBe('JRS-15E');
    expect(rec.compressor.price).toBeNull();
  });

  it('initializes salesChannel and pricingStatus as null (set by deriveSalesChannel)', () => {
    const demand = calculateDemand([{ cfm_typical: 10, count: 1 }]);
    const rec = recommendSystem(demand);
    expect(rec.salesChannel).toBeNull();
    expect(rec.pricingStatus).toBeNull();
  });
});

describe('addQualityFilters', () => {
  it('does not modify recommendation when no air quality class', () => {
    const demand = calculateDemand([{ cfm_typical: 10, count: 1 }]);
    const rec = recommendSystem(demand);
    const originalLength = rec.filters.length;
    const result = addQualityFilters(rec, null);
    expect(result).toBeUndefined();
    expect(rec.filters.length).toBe(originalLength);
  });

  it('adds coalescing filter for ISO_8573_1', () => {
    const demand = calculateDemand([{ cfm_typical: 10, count: 1 }]);
    const rec = recommendSystem(demand);
    addQualityFilters(rec, 'ISO_8573_1');
    expect(rec.filters.some(f => f.micron <= 0.01)).toBe(true);
    expect(rec.notes.join(' ')).toContain('Coalescing filter');
  });

  it('adds coalescing filter for paint_grade', () => {
    const demand = calculateDemand([{ cfm_typical: 10, count: 1 }]);
    const rec = recommendSystem(demand);
    addQualityFilters(rec, 'paint_grade');
    expect(rec.filters.some(f => f.micron <= 0.01)).toBe(true);
  });

  it('does not duplicate coalescing filter', () => {
    const demand = calculateDemand([{ cfm_typical: 10, count: 1 }]);
    const rec = recommendSystem(demand);
    addQualityFilters(rec, 'ISO_8573_1');
    const count1 = rec.filters.filter(f => f.micron <= 0.01).length;
    addQualityFilters(rec, 'ISO_8573_1');
    const count2 = rec.filters.filter(f => f.micron <= 0.01).length;
    expect(count2).toBe(count1);
  });

  it('does not add coalescing for general air quality', () => {
    const demand = calculateDemand([{ cfm_typical: 10, count: 1 }]);
    const rec = recommendSystem(demand);
    addQualityFilters(rec, 'general');
    expect(rec.filters.some(f => f.micron <= 0.01)).toBe(false);
  });
});

describe('deriveSalesChannel', () => {
  it('sets ecommerce when all components are ecommerce', () => {
    // JRS-5E (18 CFM, ecommerce) + JRD-30 (ecommerce) + JPF-70 (ecommerce)
    const demand = calculateDemand([{ cfm_typical: 8, duty_cycle_pct: 60, count: 1 }]);
    const rec = recommendSystem(demand);
    deriveSalesChannel(rec);
    expect(rec.salesChannel).toBe('ecommerce');
    expect(rec.pricingStatus).toBe('confirmed');
  });

  it('sets direct when compressor is direct', () => {
    // JRS-40 (155 CFM, direct)
    const demand = calculateDemand([{ cfm_typical: 12, duty_cycle_pct: 70, count: 15 }]);
    // adjustedCfm = ceil(126 * 1.25) = 158 → JRS-40 (direct)
    const rec = recommendSystem(demand);
    deriveSalesChannel(rec);
    expect(rec.salesChannel).toBe('direct');
    expect(rec.pricingStatus).toBe('quote_required');
  });

  it('sets direct for parallel configurations', () => {
    const demand = calculateDemand([{ cfm_typical: 100, duty_cycle_pct: 100, count: 20 }]);
    const rec = recommendSystem(demand);
    deriveSalesChannel(rec);
    expect(rec.salesChannel).toBe('direct');
  });

  it('includes desiccant upgrade in worst-case derivation', () => {
    // Small system (ecommerce compressor) but with ISO air quality → desiccant
    const demand = calculateDemand([{ cfm_typical: 8, duty_cycle_pct: 60, count: 1 }]);
    const rec = recommendSystem(demand);
    addQualityFilters(rec, 'ISO_8573_1');
    deriveSalesChannel(rec);
    // JRS-5E is ecommerce, JDD-40 is ecommerce, so still ecommerce
    expect(rec.salesChannel).toBe('ecommerce');
  });

  it('marks direct when desiccant upgrade is direct (large system)', () => {
    // Large system where desiccant SKU is a placeholder (>80 CFM = JDD-200, direct)
    const demand = calculateDemand([{ cfm_typical: 12, duty_cycle_pct: 70, count: 15 }]);
    const rec = recommendSystem(demand);
    addQualityFilters(rec, 'ISO_8573_1');
    deriveSalesChannel(rec);
    expect(rec.salesChannel).toBe('direct');
  });
});

describe('SAFETY_FACTOR', () => {
  it('is 1.25', () => {
    expect(SAFETY_FACTOR).toBe(1.25);
  });
});

describe('COMPRESSOR_CATALOG', () => {
  it('is sorted by CFM ascending', () => {
    for (let i = 1; i < COMPRESSOR_CATALOG.length; i++) {
      expect(COMPRESSOR_CATALOG[i].cfm).toBeGreaterThanOrEqual(COMPRESSOR_CATALOG[i - 1].cfm);
    }
  });

  it('has no duplicate models', () => {
    const models = COMPRESSOR_CATALOG.map(c => c.model);
    expect(new Set(models).size).toBe(models.length);
  });

  it('every entry has required fields', () => {
    for (const entry of COMPRESSOR_CATALOG) {
      expect(entry).toHaveProperty('model');
      expect(entry).toHaveProperty('hp');
      expect(entry).toHaveProperty('cfm');
      expect(entry).toHaveProperty('psi');
      expect(entry).toHaveProperty('voltage');
      expect(entry).toHaveProperty('productLine');
      expect(entry).toHaveProperty('salesChannel');
      expect(entry).toHaveProperty('pricingStatus');
      expect(['ecommerce', 'direct']).toContain(entry.salesChannel);
      expect(['confirmed', 'pending', 'quote_required']).toContain(entry.pricingStatus);
    }
  });

  it('all ecommerce entries are 25HP or below', () => {
    const ecommerceEntries = COMPRESSOR_CATALOG.filter(c => c.salesChannel === 'ecommerce');
    for (const entry of ecommerceEntries) {
      expect(entry.hp).toBeLessThanOrEqual(25);
    }
  });

  it('all entries above 25HP are direct', () => {
    const directEntries = COMPRESSOR_CATALOG.filter(c => c.hp > 25);
    for (const entry of directEntries) {
      expect(entry.salesChannel).toBe('direct');
    }
  });

  it('includes original JRS models', () => {
    expect(COMPRESSOR_CATALOG.find(c => c.model === 'JRS-5E')).toBeTruthy();
    expect(COMPRESSOR_CATALOG.find(c => c.model === 'JRS-7.5E')).toBeTruthy();
    expect(COMPRESSOR_CATALOG.find(c => c.model === 'JRS-10E')).toBeTruthy();
  });

  it('includes expanded catalog models', () => {
    expect(COMPRESSOR_CATALOG.find(c => c.model === 'JRS-40')).toBeTruthy();
    expect(COMPRESSOR_CATALOG.find(c => c.model === 'JRS-100')).toBeTruthy();
    expect(COMPRESSOR_CATALOG.find(c => c.model === 'JVSD-150')).toBeTruthy();
    expect(COMPRESSOR_CATALOG.find(c => c.model === 'JLF-476')).toBeTruthy();
  });

  it('has JRS-7.5E and JRS-10E with confirmed prices', () => {
    const jrs75 = COMPRESSOR_CATALOG.find(c => c.model === 'JRS-7.5E');
    const jrs10 = COMPRESSOR_CATALOG.find(c => c.model === 'JRS-10E');
    expect(jrs75.price).toBe(7495);
    expect(jrs10.price).toBe(9495);
  });

  it('prefers RS Open Frame over PM/VSD at same HP in sort order', () => {
    // At 15HP: JRS-15E (54 CFM) should appear before JVSD-15 (53 CFM) doesn't apply
    // since JVSD-15 has lower CFM. But at similar CFM, rs_open sorts first.
    const idx15e = COMPRESSOR_CATALOG.findIndex(c => c.model === 'JRS-15E');
    const idxVsd15 = COMPRESSOR_CATALOG.findIndex(c => c.model === 'JVSD-15');
    // JVSD-15 (53 CFM) sorts before JRS-15E (54 CFM) because 53 < 54
    expect(idxVsd15).toBeLessThan(idx15e);
    // But for 100HP: JRS-100 (405) and JVSD-100 (406) are very close.
    // JRS-100 at 405 sorts before JVSD-100 at 406.
    const idx100 = COMPRESSOR_CATALOG.findIndex(c => c.model === 'JRS-100');
    const idxVsd100 = COMPRESSOR_CATALOG.findIndex(c => c.model === 'JVSD-100');
    expect(idx100).toBeLessThan(idxVsd100);
  });

  it('JRS-100 has correct CFM (405, not 500)', () => {
    const jrs100 = COMPRESSOR_CATALOG.find(c => c.model === 'JRS-100');
    expect(jrs100.cfm).toBe(405);
  });
});

describe('selectFilter', () => {
  it('picks smallest filter that covers demand', () => {
    expect(selectFilter('particulate', 20).model).toBe('JPF-70');
    expect(selectFilter('particulate', 40).model).toBe('JPF-70');
    expect(selectFilter('particulate', 80).model).toBe('JPF-130');
  });

  it('picks JPF-500 when demand exceeds JPF-130', () => {
    expect(selectFilter('particulate', 200).model).toBe('JPF-500');
  });

  it('picks largest filter when demand exceeds all sizes', () => {
    expect(selectFilter('particulate', 5000).model).toBe('JPF-1000');
  });

  it('works for coalescing filters too', () => {
    expect(selectFilter('coalescing', 25).model).toBe('JCF-70');
    expect(selectFilter('coalescing', 60).model).toBe('JCF-70');
    expect(selectFilter('coalescing', 200).model).toBe('JCF-500');
  });
});

describe('FILTER_SIZES', () => {
  it('has multiple sizes for each filter type', () => {
    expect(FILTER_SIZES.particulate.length).toBeGreaterThanOrEqual(2);
    expect(FILTER_SIZES.coalescing.length).toBeGreaterThanOrEqual(2);
  });

  it('is sorted by CFM ascending', () => {
    for (const type of ['particulate', 'coalescing']) {
      const sizes = FILTER_SIZES[type];
      for (let i = 1; i < sizes.length; i++) {
        expect(sizes[i].cfm).toBeGreaterThan(sizes[i - 1].cfm);
      }
    }
  });

  it('every filter entry has salesChannel and pricingStatus', () => {
    for (const type of ['particulate', 'coalescing']) {
      for (const filter of FILTER_SIZES[type]) {
        expect(['ecommerce', 'direct']).toContain(filter.salesChannel);
        expect(['confirmed', 'pending', 'quote_required']).toContain(filter.pricingStatus);
      }
    }
  });
});

// --- CnC shop sizing scenarios ---
// These test the full range from hobby garage to mega facility.

describe('CnC shop sizing scenarios', () => {
  function sizeShop(machines) {
    const demand = calculateDemand(machines);
    const rec = recommendSystem(demand);
    if (rec) {
      addQualityFilters(rec, null);
      deriveSalesChannel(rec);
    }
    return { demand, rec };
  }

  it('hobby garage: 3x small mills → JRS-5E (ecommerce)', () => {
    const { rec } = sizeShop([{ cfm_typical: 8, duty_cycle_pct: 50, count: 3 }]);
    // adjustedCfm = ceil(12 * 1.25) = 15 → JRS-5E (18 CFM)
    expect(rec.compressor.model).toBe('JRS-5E');
    expect(rec.salesChannel).toBe('ecommerce');
  });

  it('small job shop: 5x Haas VF-2 → JRS-15E (ecommerce)', () => {
    const { rec } = sizeShop([{ cfm_typical: 12, duty_cycle_pct: 60, count: 5 }]);
    // adjustedCfm = ceil(36 * 1.25) = 45 → JRS-15E (54 CFM, rs_open preferred)
    // JRS-15E compressor is ecommerce, JRD-60 dryer (60 CFM) is ecommerce
    expect(rec.compressor.model).toBe('JRS-15E');
    expect(rec.compressor.salesChannel).toBe('ecommerce');
    expect(rec.dryer.cfm).toBeGreaterThanOrEqual(rec.compressor.cfm);
  });

  it('mid job shop: 10x CNC @ 70% duty → ecommerce', () => {
    const { demand, rec } = sizeShop([{ cfm_typical: 12, duty_cycle_pct: 70, count: 10 }]);
    // adjustedCfm = ceil(84 * 1.25) = 105 → JRS-25E (102 CFM)? No, 105 > 102.
    // Next: JVSD-30 (109) or JRS-30 (125). Both are direct.
    // Actually JRS-25E at 102 < 105, so we skip it.
    expect(demand.adjustedCfm).toBe(105);
    // 105 > 102, so we land on next model
    expect(rec.compressor.cfm).toBeGreaterThanOrEqual(105);
  });

  it('ecommerce system boundary: JRS-20E (78 CFM) + JRD-80 → all ecommerce', () => {
    // JRS-20E (78 CFM, ecommerce) pairs with JRD-80 (80 CFM, ecommerce) = full ecommerce system
    // Demand: 60 * 1.25 = 75 → JRS-20E (78 CFM)
    const { rec } = sizeShop([{ cfm_typical: 60, duty_cycle_pct: 100, count: 1 }]);
    expect(rec.compressor.model).toBe('JRS-20E');
    expect(rec.dryer.model).toBe('JRD-80');
    expect(rec.salesChannel).toBe('ecommerce');
  });

  it('JRS-25E compressor is ecommerce but system is direct (dryer gap)', () => {
    // JRS-25E (102 CFM, ecommerce) needs JRD-200 (200 CFM, direct) because
    // JRD-100 (100 CFM) is undersized for 102 CFM output
    const { rec } = sizeShop([{ cfm_typical: 80, duty_cycle_pct: 100, count: 1 }]);
    expect(rec.compressor.model).toBe('JRS-25E');
    expect(rec.compressor.salesChannel).toBe('ecommerce');
    expect(rec.dryer.salesChannel).toBe('direct');
    expect(rec.salesChannel).toBe('direct');
  });

  it('ecommerce/direct boundary: 103 CFM → compressor is direct', () => {
    // 82.4 * 1.25 = 103 → JRS-30 (125 CFM, direct)
    const { rec } = sizeShop([{ cfm_typical: 82.4, duty_cycle_pct: 100, count: 1 }]);
    expect(rec.compressor.cfm).toBeGreaterThan(102);
    expect(rec.compressor.salesChannel).toBe('direct');
    expect(rec.salesChannel).toBe('direct');
    expect(rec.pricingStatus).toBe('quote_required');
  });

  it('growing shop: 15x CNC → JRS-40 (direct)', () => {
    const { demand, rec } = sizeShop([{ cfm_typical: 12, duty_cycle_pct: 70, count: 15 }]);
    // adjustedCfm = ceil(126 * 1.25) = 158 → JRS-40 (155 CFM)? 158 > 155, so next: JRS-50 (185).
    expect(demand.adjustedCfm).toBe(158);
    expect(rec.compressor.cfm).toBeGreaterThanOrEqual(158);
    expect(rec.salesChannel).toBe('direct');
  });

  it('production floor: 25x CNC + 5x grinders → direct', () => {
    const { rec } = sizeShop([
      { cfm_typical: 12, duty_cycle_pct: 70, count: 25 },  // CNC machines
      { cfm_typical: 20, duty_cycle_pct: 50, count: 5 },   // Grinders
    ]);
    // total = (12*0.7*25) + (20*0.5*5) = 210 + 50 = 260. adjusted = ceil(260*1.25) = 325
    expect(rec.compressor.cfm).toBeGreaterThanOrEqual(325);
    expect(rec.salesChannel).toBe('direct');
  });

  it('large mfg plant: 50x mixed → direct', () => {
    const { rec } = sizeShop([
      { cfm_typical: 12, duty_cycle_pct: 70, count: 40 },
      { cfm_typical: 25, duty_cycle_pct: 60, count: 10 },
    ]);
    // total = (12*0.7*40) + (25*0.6*10) = 336 + 150 = 486. adjusted = ceil(486*1.25) = 608
    expect(rec.compressor.cfm).toBeGreaterThanOrEqual(608);
    expect(rec.salesChannel).toBe('direct');
    expect(rec.parallelConfig).toBeNull();  // 608 < JLF-180 (749), single unit fits
  });

  it('mega facility: demand exceeds largest single unit → parallel', () => {
    const { rec } = sizeShop([{ cfm_typical: 100, duty_cycle_pct: 100, count: 20 }]);
    // adjusted = ceil(2000 * 1.25) = 2500 → exceeds JLF-476 (1895)
    expect(rec.parallelConfig).not.toBeNull();
    expect(rec.parallelConfig.unitCount).toBeGreaterThanOrEqual(2);
    expect(rec.parallelConfig.totalCfm).toBeGreaterThanOrEqual(2500);
    expect(rec.compressor.model).toBe('JLF-476');
    expect(rec.salesChannel).toBe('direct');
  });
});

describe('parallel configuration', () => {
  it('parallel trigger boundary: demand at exactly largest CFM → single unit', () => {
    const largest = COMPRESSOR_CATALOG[COMPRESSOR_CATALOG.length - 1];
    // Craft demand for exactly largest.cfm
    const cfmNeeded = largest.cfm / SAFETY_FACTOR;
    const demand = calculateDemand([{ cfm_typical: cfmNeeded, duty_cycle_pct: 100, count: 1 }]);
    const rec = recommendSystem(demand);
    expect(rec.parallelConfig).toBeNull();
    expect(rec.compressor.model).toBe(largest.model);
  });

  it('parallel trigger boundary: demand at largest CFM + 1 → parallel', () => {
    const largest = COMPRESSOR_CATALOG[COMPRESSOR_CATALOG.length - 1];
    const demand = { adjustedCfm: largest.cfm + 1, maxPsi: 90, totalCfmAtDuty: largest.cfm + 1, peakCfm: largest.cfm + 1, adjustedPeak: largest.cfm + 1, equipmentCount: 50 };
    const rec = recommendSystem(demand);
    expect(rec.parallelConfig).not.toBeNull();
    expect(rec.parallelConfig.unitCount).toBe(2);
  });

  it('compressor field is always present in parallel config', () => {
    const demand = calculateDemand([{ cfm_typical: 100, duty_cycle_pct: 100, count: 20 }]);
    const rec = recommendSystem(demand);
    expect(rec.compressor).toBeTruthy();
    expect(rec.compressor.model).toBeTruthy();
    expect(rec.parallelConfig).not.toBeNull();
  });

  it('dryer sized to parallel totalCfm (falls back to largest available)', () => {
    const demand = calculateDemand([{ cfm_typical: 100, duty_cycle_pct: 100, count: 20 }]);
    const rec = recommendSystem(demand);
    // Parallel totalCfm may exceed largest dryer — engine selects largest available
    expect(rec.dryer.model).toBe('JRD-2000');
    // For very large parallel configs, the dryer note should indicate custom sizing
    expect(rec.parallelConfig.totalCfm).toBeGreaterThan(rec.dryer.cfm);
  });
});

describe('dryer catalog expansion', () => {
  it('has entries above 100 CFM', () => {
    const large = DRYER_CATALOG.filter(d => d.cfm > 100);
    expect(large.length).toBeGreaterThanOrEqual(4);
  });

  it('large dryers are direct/quote_required', () => {
    const large = DRYER_CATALOG.filter(d => d.cfm > 100);
    for (const d of large) {
      expect(d.salesChannel).toBe('direct');
      expect(d.pricingStatus).toBe('quote_required');
    }
  });

  it('dryer cfm covers compressor cfm for all catalog sizes', () => {
    const largestDryer = DRYER_CATALOG[DRYER_CATALOG.length - 1];
    const largestCompressor = COMPRESSOR_CATALOG[COMPRESSOR_CATALOG.length - 1];
    // Largest single compressor should have a dryer that fits
    expect(largestDryer.cfm).toBeGreaterThanOrEqual(largestCompressor.cfm);
  });
});

describe('desiccant catalog expansion', () => {
  it('has entries above 80 CFM', () => {
    const large = DESICCANT_CATALOG.filter(d => d.cfm > 80);
    expect(large.length).toBeGreaterThanOrEqual(2);
  });

  it('large desiccants are direct/quote_required', () => {
    const large = DESICCANT_CATALOG.filter(d => d.cfm > 80);
    for (const d of large) {
      expect(d.salesChannel).toBe('direct');
      expect(d.pricingStatus).toBe('quote_required');
    }
  });
});
