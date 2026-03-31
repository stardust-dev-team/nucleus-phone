const {
  calculateDemand,
  recommendSystem,
  addQualityFilters,
  selectFilter,
  SAFETY_FACTOR,
  COMPRESSOR_CATALOG,
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
    // 20 * 1.0 * 1 = 20
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
    // Equipment that doesn't use air (e.g., standby mode)
    const result = calculateDemand([
      { cfm_typical: 10, duty_cycle_pct: 0, count: 1 },
      { cfm_typical: 20, duty_cycle_pct: 50, count: 1 },
    ]);
    // 10 * 0.0 + 20 * 0.5 = 10
    expect(result.totalCfmAtDuty).toBe(10);
  });
});

describe('recommendSystem', () => {
  it('returns null for null demand', () => {
    expect(recommendSystem(null)).toBeNull();
  });

  it('recommends JRS-5E for very low demand', () => {
    const demand = calculateDemand([{ cfm_typical: 8, duty_cycle_pct: 60, count: 1 }]);
    // adjustedCfm = ceil(4.8 * 1.25) = ceil(6.0) = 6 → fits JRS-5E (18 CFM)
    const rec = recommendSystem(demand);
    expect(rec.compressor.model).toBe('JRS-5E');
    expect(rec.dryer).toBeTruthy();
    expect(rec.filters.length).toBeGreaterThan(0);
  });

  it('recommends JRS-7.5E for moderate low demand', () => {
    const demand = calculateDemand([{ cfm_typical: 12, duty_cycle_pct: 100, count: 1 }]);
    // adjustedCfm = ceil(12 * 1.25) = 15 → still fits JRS-5E (18 CFM)
    // But slightly higher:
    const demand2 = calculateDemand([{ cfm_typical: 15, duty_cycle_pct: 100, count: 1 }]);
    // adjustedCfm = ceil(15 * 1.25) = ceil(18.75) = 19 → JRS-7.5E (28 CFM)
    const rec2 = recommendSystem(demand2);
    expect(rec2.compressor.model).toBe('JRS-7.5E');
    expect(rec2.compressor.price).toBe(7495);
  });

  it('recommends JRS-10E for medium demand', () => {
    const demand = calculateDemand([{ cfm_typical: 12, duty_cycle_pct: 60, count: 3 }]);
    // adjustedCfm = ceil(21.6 * 1.25) = 27 → fits JRS-7.5E (28 CFM)
    const rec = recommendSystem(demand);
    expect(rec.compressor.model).toBe('JRS-7.5E');

    // Bump to exceed 28 CFM threshold
    const demand2 = calculateDemand([{ cfm_typical: 12, duty_cycle_pct: 80, count: 3 }]);
    // adjustedCfm = ceil(28.8 * 1.25) = ceil(36.0) = 36 → JRS-10E (40 CFM)
    const rec2 = recommendSystem(demand2);
    expect(rec2.compressor.model).toBe('JRS-10E');
    expect(rec2.compressor.price).toBe(9495);
  });

  it('recommends largest unit and notes parallel config when demand exceeds catalog', () => {
    const demand = calculateDemand([{ cfm_typical: 50, duty_cycle_pct: 100, count: 3 }]);
    // adjustedCfm = ceil(150 * 1.25) = 188 → exceeds JRS-25E (100 CFM)
    const rec = recommendSystem(demand);
    expect(rec.compressor.model).toBe('JRS-25E');
    expect(rec.notes.join(' ')).toContain('parallel configuration');
  });

  it('notes high PSI requirements', () => {
    const demand = { totalCfmAtDuty: 20, peakCfm: 30, adjustedCfm: 25, adjustedPeak: 38, maxPsi: 150, equipmentCount: 2 };
    const rec = recommendSystem(demand);
    expect(rec.notes.join(' ')).toContain('High PSI');
  });

  it('selects dryer matching compressor capacity', () => {
    const demand = calculateDemand([{ cfm_typical: 30, duty_cycle_pct: 80, count: 1 }]);
    const rec = recommendSystem(demand);
    // Dryer CFM should be >= compressor CFM
    expect(rec.dryer.cfm).toBeGreaterThanOrEqual(rec.compressor.cfm);
  });

  it('always includes particulate filter sized to compressor', () => {
    const demand = calculateDemand([{ cfm_typical: 10, count: 1 }]);
    const rec = recommendSystem(demand);
    expect(rec.filters.some(f => f.micron === 1)).toBe(true);
    // Filter CFM should cover compressor output
    const pf = rec.filters.find(f => f.micron === 1);
    expect(pf.cfm).toBeGreaterThanOrEqual(rec.compressor.cfm);
  });

  it('includes price: null for TBD items', () => {
    const demand = calculateDemand([{ cfm_typical: 40, duty_cycle_pct: 100, count: 1 }]);
    // adjustedCfm = ceil(40 * 1.25) = 50 → JRS-15E (price: null)
    const rec = recommendSystem(demand);
    expect(rec.compressor.model).toBe('JRS-15E');
    expect(rec.compressor.price).toBeNull();
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
    addQualityFilters(rec, 'ISO_8573_1'); // call again
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

describe('SAFETY_FACTOR', () => {
  it('is 1.25', () => {
    expect(SAFETY_FACTOR).toBe(1.25);
  });
});

describe('COMPRESSOR_CATALOG', () => {
  it('is sorted by CFM ascending', () => {
    for (let i = 1; i < COMPRESSOR_CATALOG.length; i++) {
      expect(COMPRESSOR_CATALOG[i].cfm).toBeGreaterThan(COMPRESSOR_CATALOG[i - 1].cfm);
    }
  });

  it('includes 5HP, 7.5HP, and 10HP models', () => {
    expect(COMPRESSOR_CATALOG.find(c => c.model === 'JRS-5E')).toBeTruthy();
    expect(COMPRESSOR_CATALOG.find(c => c.model === 'JRS-7.5E')).toBeTruthy();
    expect(COMPRESSOR_CATALOG.find(c => c.model === 'JRS-10E')).toBeTruthy();
  });

  it('has JRS-7.5E and JRS-10E with prices', () => {
    const jrs75 = COMPRESSOR_CATALOG.find(c => c.model === 'JRS-7.5E');
    const jrs10 = COMPRESSOR_CATALOG.find(c => c.model === 'JRS-10E');
    expect(jrs75.price).toBe(7495);
    expect(jrs10.price).toBe(9495);
  });
});

describe('selectFilter', () => {
  it('picks smallest filter that covers demand', () => {
    expect(selectFilter('particulate', 20).model).toBe('PF-30-8');
    expect(selectFilter('particulate', 40).model).toBe('PF-55-8');
    expect(selectFilter('particulate', 80).model).toBe('PF-100-8');
  });

  it('picks largest filter when demand exceeds all sizes', () => {
    expect(selectFilter('particulate', 200).model).toBe('PF-100-8');
  });

  it('works for coalescing filters too', () => {
    expect(selectFilter('coalescing', 25).model).toBe('CF-30-8');
    expect(selectFilter('coalescing', 60).model).toBe('CF-100-8');
  });
});

describe('FILTER_SIZES', () => {
  it('has multiple sizes for each filter type', () => {
    expect(FILTER_SIZES.particulate.length).toBeGreaterThanOrEqual(3);
    expect(FILTER_SIZES.coalescing.length).toBeGreaterThanOrEqual(3);
  });

  it('is sorted by CFM ascending', () => {
    for (const type of ['particulate', 'coalescing']) {
      const sizes = FILTER_SIZES[type];
      for (let i = 1; i < sizes.length; i++) {
        expect(sizes[i].cfm).toBeGreaterThan(sizes[i - 1].cfm);
      }
    }
  });
});
