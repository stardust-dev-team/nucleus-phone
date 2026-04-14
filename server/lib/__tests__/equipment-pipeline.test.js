const { detectAirQualityContext, AQ_CONTEXT_PATTERNS } = require('../equipment-pipeline');

describe('detectAirQualityContext', () => {
  it('detects AS9100 as ISO_8573_1', () => {
    expect(detectAirQualityContext('We run AS9100 aerospace work')).toBe('ISO_8573_1');
  });

  it('detects AS-9100 with hyphen', () => {
    expect(detectAirQualityContext('certified to AS-9100')).toBe('ISO_8573_1');
  });

  it('detects AS 9100 with space', () => {
    expect(detectAirQualityContext('our AS 9100 environment')).toBe('ISO_8573_1');
  });

  it('detects aerospace keyword', () => {
    expect(detectAirQualityContext('we do aerospace bracket work')).toBe('ISO_8573_1');
  });

  it('detects pharmaceutical', () => {
    expect(detectAirQualityContext('pharmaceutical manufacturing facility')).toBe('ISO_8573_1');
  });

  it('detects pharma abbreviation', () => {
    expect(detectAirQualityContext('we are a pharma company')).toBe('ISO_8573_1');
  });

  it('detects ISO 8573', () => {
    expect(detectAirQualityContext('ISO 8573 class 1 air quality')).toBe('ISO_8573_1');
  });

  it('detects medical device', () => {
    expect(detectAirQualityContext('medical device manufacturing')).toBe('ISO_8573_1');
  });

  it('detects clean room', () => {
    expect(detectAirQualityContext('we have a clean room')).toBe('ISO_8573_1');
  });

  it('detects paint booth as paint_grade', () => {
    expect(detectAirQualityContext('we run a paint booth')).toBe('paint_grade');
  });

  it('detects spray booth as paint_grade', () => {
    expect(detectAirQualityContext('our spray booth needs clean air')).toBe('paint_grade');
  });

  it('detects auto body as paint_grade', () => {
    expect(detectAirQualityContext('auto body shop')).toBe('paint_grade');
  });

  it('detects powder coat as paint_grade', () => {
    expect(detectAirQualityContext('we do powder coating')).toBe('paint_grade');
  });

  it('returns null for general machining text', () => {
    expect(detectAirQualityContext('we run five CNC machines')).toBeNull();
  });

  it('returns null for empty text', () => {
    expect(detectAirQualityContext('')).toBeNull();
  });

  it('ISO_8573_1 wins over paint_grade when both present', () => {
    expect(detectAirQualityContext('aerospace paint booth operations')).toBe('ISO_8573_1');
  });

  it('is case insensitive', () => {
    expect(detectAirQualityContext('AEROSPACE manufacturing')).toBe('ISO_8573_1');
    expect(detectAirQualityContext('Paint Booth')).toBe('paint_grade');
  });
});

describe('resolveAirQuality', () => {
  const { resolveAirQuality } = require('../equipment-pipeline');
  const { setCallAirQuality, cleanupCall } = require('../live-analysis');

  const testCallIds = [];
  afterAll(() => { for (const id of testCallIds) cleanupCall(id); });
  function trackCall(id) { testCallIds.push(id); return id; }

  it('returns null when equipment is general and no context', () => {
    const accumulated = [{ air_quality_class: 'general' }];
    expect(resolveAirQuality(accumulated, 'test-no-context')).toBeNull();
  });

  it('returns paint_grade from equipment when no context override', () => {
    const accumulated = [
      { air_quality_class: 'general' },
      { air_quality_class: 'paint_grade' },
    ];
    expect(resolveAirQuality(accumulated, 'test-paint-equip')).toBe('paint_grade');
  });

  it('returns ISO_8573_1 from equipment when present', () => {
    const accumulated = [
      { air_quality_class: 'general' },
      { air_quality_class: 'ISO_8573_1' },
    ];
    expect(resolveAirQuality(accumulated, 'test-iso-equip')).toBe('ISO_8573_1');
  });

  it('context overrides general equipment to ISO_8573_1 (the Mike Garza case)', () => {
    const callId = trackCall('test-context-override');
    setCallAirQuality(callId, 'ISO_8573_1');
    const accumulated = [
      { air_quality_class: 'general' },  // CNC machines default to general
      { air_quality_class: 'general' },
    ];
    expect(resolveAirQuality(accumulated, callId)).toBe('ISO_8573_1');
  });

  it('context overrides general equipment to paint_grade', () => {
    const callId = trackCall('test-context-paint');
    setCallAirQuality(callId, 'paint_grade');
    const accumulated = [{ air_quality_class: 'general' }];
    expect(resolveAirQuality(accumulated, callId)).toBe('paint_grade');
  });

  it('ISO_8573_1 context wins over paint_grade equipment', () => {
    const callId = trackCall('test-iso-over-paint');
    setCallAirQuality(callId, 'ISO_8573_1');
    const accumulated = [{ air_quality_class: 'paint_grade' }];
    expect(resolveAirQuality(accumulated, callId)).toBe('ISO_8573_1');
  });

  it('equipment ISO_8573_1 wins over paint_grade context', () => {
    const callId = trackCall('test-equip-over-context');
    setCallAirQuality(callId, 'paint_grade');
    const accumulated = [{ air_quality_class: 'ISO_8573_1' }];
    expect(resolveAirQuality(accumulated, callId)).toBe('ISO_8573_1');
  });
});

describe('AQ_CONTEXT_PATTERNS coverage', () => {
  it('every pattern has at least one matching test case above', () => {
    // Verify all patterns are reachable — prevents dead patterns from accumulating
    const testInputs = [
      'AS9100', 'aerospace', 'pharma', 'ISO 8573',
      'medical device', 'clean room',
      'paint booth', 'spray booth', 'auto body', 'powder coating',
    ];
    for (const { re } of AQ_CONTEXT_PATTERNS) {
      const matched = testInputs.some(input => re.test(input));
      expect(matched).toBe(true);
    }
  });
});
