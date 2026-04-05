const { buildVernacular } = require('../company-vernacular');

describe('buildVernacular', () => {
  test('returns guaranteed shape with all empty inputs', () => {
    const v = buildVernacular({});
    expect(v.equipment).toEqual([]);
    expect(v.painPoints).toEqual([]);
    expect(v.productsDiscussed).toEqual([]);
    expect(v.competitorsMentioned).toEqual([]);
    expect(v.lastSizing).toBeNull();
    expect(v.certContext).toBeNull();
    expect(v.hubspotVernacular).toBeNull();
    expect(v.tenKInsights).toBeNull();
    expect(v.leadershipStrategy).toBeNull();
    expect(v.complianceContext).toBeNull();
    expect(v.capitalEquipment).toBeNull();
    expect(v.sourceCount).toBe(0);
  });

  test('extracts equipment and pain points from interaction history', () => {
    const v = buildVernacular({
      interactionHistory: {
        interactions: [
          {
            sizing_data: { equipment_type: 'piston compressor', brand: 'Ingersoll Rand', hp: 25, age: '7 years' },
            summary: 'Customer reports moisture issues and short-cycling on current unit',
            qualification: { reason: 'downtime causing production delays' },
          },
        ],
        productsDiscussed: ['JRS-10E'],
      },
    });
    expect(v.equipment).toEqual(['piston compressor, Ingersoll Rand, 25HP, 7 years']);
    expect(v.painPoints).toContain('moisture');
    expect(v.painPoints).toContain('short-cycling');
    expect(v.painPoints).toContain('downtime');
    expect(v.productsDiscussed).toEqual(['JRS-10E']);
    expect(v.lastSizing).toBeNull(); // no cfm/psi in this sizing_data
    expect(v.sourceCount).toBe(1);
  });

  test('extracts sizing data from interactions', () => {
    const v = buildVernacular({
      interactionHistory: {
        interactions: [
          { sizing_data: { cfm: 50, psi: 125, machines: 5 } },
        ],
      },
    });
    expect(v.lastSizing).toEqual({ cfm: 50, psi: 125, hp: null, machines: 5, tank_size: null });
  });

  test('aggregates products from calls and interactions', () => {
    const v = buildVernacular({
      interactionHistory: { interactions: [], productsDiscussed: ['JRS-10E'] },
      priorCalls: [
        { products_discussed: ['JDD-40', 'JRS-10E'] },
        { products_discussed: ['JCF-70'] },
      ],
    });
    expect(v.productsDiscussed.sort()).toEqual(['JCF-70', 'JDD-40', 'JRS-10E']);
  });

  test('extracts competitors from competitive_intel and source_metadata', () => {
    const v = buildVernacular({
      interactionHistory: {
        interactions: [
          { competitive_intel: { mentions: ['Atlas Copco', 'Kaeser'] } },
          { source_metadata: { competitiveMentions: ['Sullair', 'Atlas Copco'] } },
        ],
      },
    });
    expect(v.competitorsMentioned).toEqual(['Atlas Copco', 'Kaeser', 'Sullair']);
  });

  test('builds cert context from signal metadata', () => {
    const v = buildVernacular({
      icpAndSignal: {
        cert_standard: 'AS9100',
        cert_body: 'NQA',
        cert_expiry_date: '2026-10-15T00:00:00Z',
      },
    });
    expect(v.certContext).toContain('AS9100');
    expect(v.certContext).toContain('NQA');
    expect(v.certContext).toContain('October 2026');
    expect(v.sourceCount).toBe(1);
  });

  test('handles expired cert', () => {
    const v = buildVernacular({
      icpAndSignal: {
        cert_standard: 'ISO 9001',
        cert_expiry_date: '2024-01-01T00:00:00Z',
      },
    });
    expect(v.certContext).toContain('EXPIRED');
  });

  test('extracts HubSpot intelligence properties', () => {
    const v = buildVernacular({
      companyData: {
        properties: {
          company_vernacular: 'Uses Plant 1 and Plant 2 naming internally',
          ten_k_insights: '### Strategic Initiatives...',
          leadership_ceo_strategy: 'Win Strategy 3.0',
          capital_equipment_insights: 'New aerospace complex contract',
          compliance_violation_type: 'Wastewater discharge exceedance',
          compliance_violation_date: '2025-08-13',
          environmental_compliance_budget: '$88M accrual for environmental matters',
        },
      },
    });
    expect(v.hubspotVernacular).toContain('Plant 1');
    expect(v.tenKInsights).toContain('Strategic');
    expect(v.leadershipStrategy).toBe('Win Strategy 3.0');
    expect(v.capitalEquipment).toContain('aerospace');
    expect(v.complianceContext).toContain('Wastewater');
    expect(v.complianceContext).toContain('2025-08-13');
    expect(v.complianceContext).toContain('$88M');
    expect(v.sourceCount).toBe(3); // vernacular + 10-K + compliance
  });

  test('caps arrays at limits', () => {
    const v = buildVernacular({
      interactionHistory: {
        interactions: Array.from({ length: 20 }, (_, i) => ({
          summary: `Issue ${i}: moisture leak downtime pressure drop overheating vibration`,
        })),
      },
    });
    expect(v.painPoints.length).toBeLessThanOrEqual(5);
  });

  test('full multi-source aggregation', () => {
    const v = buildVernacular({
      icpAndSignal: { cert_standard: 'AS9100', cert_body: 'BSI' },
      interactionHistory: {
        interactions: [{ summary: 'Discussed moisture issues' }],
        productsDiscussed: ['JRS-10E'],
      },
      priorCalls: [{ products_discussed: ['JDD-40'], notes: 'Mentioned downtime concerns' }],
      companyData: { properties: { company_vernacular: 'Internal facility naming' } },
    });
    expect(v.sourceCount).toBe(4); // interactions + calls + cert + vernacular
    expect(v.productsDiscussed).toEqual(['JRS-10E', 'JDD-40']);
    expect(v.painPoints).toContain('moisture');
    expect(v.painPoints).toContain('downtime');
    expect(v.certContext).toContain('AS9100');
    expect(v.hubspotVernacular).toContain('facility');
  });
});
