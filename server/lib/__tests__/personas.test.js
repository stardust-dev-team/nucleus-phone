const { listPersonas, resolveAssistantId, validatePersonaConfig, _resetCache } = require('../personas');

describe('lib/personas', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    _resetCache();
  });

  describe('listPersonas()', () => {
    test('returns mike-garza as the only persona today', () => {
      const personas = listPersonas();
      expect(personas).toHaveLength(1);
      expect(personas[0]).toMatchObject({
        id: 'mike-garza',
        displayName: 'Mike Garza',
        difficulties: ['easy', 'medium', 'hard'],
      });
    });

    test('strips assistantEnvVars from the public shape', () => {
      const [mike] = listPersonas();
      expect(mike.assistantEnvVars).toBeUndefined();
    });

    test('omits assistantInboundNumbers under Architecture B', () => {
      const [mike] = listPersonas();
      expect(mike.assistantInboundNumbers).toBeUndefined();
    });

    test('every persona has role + summary populated (UI contract)', () => {
      for (const p of listPersonas()) {
        expect(typeof p.role).toBe('string');
        expect(p.role.length).toBeGreaterThan(0);
        expect(typeof p.summary).toBe('string');
        expect(p.summary.length).toBeGreaterThan(0);
      }
    });
  });

  describe('resolveAssistantId()', () => {
    test('returns the new env var when set', () => {
      process.env.VAPI_SIM_MIKE_GARZA_EASY_ID = 'new-easy-id';
      process.env.VAPI_SIM_EASY_ID = 'legacy-easy-id';
      expect(resolveAssistantId({ personaId: 'mike-garza', difficulty: 'easy' })).toBe('new-easy-id');
    });

    test('falls back to the legacy env var when the new one is unset', () => {
      delete process.env.VAPI_SIM_MIKE_GARZA_MEDIUM_ID;
      process.env.VAPI_SIM_MEDIUM_ID = 'legacy-medium-id';
      expect(resolveAssistantId({ personaId: 'mike-garza', difficulty: 'medium' })).toBe('legacy-medium-id');
    });

    test('returns undefined when both new and legacy are unset', () => {
      delete process.env.VAPI_SIM_MIKE_GARZA_HARD_ID;
      delete process.env.VAPI_SIM_HARD_ID;
      expect(resolveAssistantId({ personaId: 'mike-garza', difficulty: 'hard' })).toBeUndefined();
    });

    test('returns undefined for an unknown personaId', () => {
      process.env.VAPI_SIM_MIKE_GARZA_EASY_ID = 'set';
      expect(resolveAssistantId({ personaId: 'who-dis', difficulty: 'easy' })).toBeUndefined();
    });

    test('returns undefined for a difficulty not declared by the persona', () => {
      process.env.VAPI_SIM_MIKE_GARZA_EASY_ID = 'set';
      expect(resolveAssistantId({ personaId: 'mike-garza', difficulty: 'impossible' })).toBeUndefined();
    });

    test('an empty-string env value is treated as unset (legacy fallback engages)', () => {
      process.env.VAPI_SIM_MIKE_GARZA_EASY_ID = '';
      process.env.VAPI_SIM_EASY_ID = 'legacy-easy-id';
      expect(resolveAssistantId({ personaId: 'mike-garza', difficulty: 'easy' })).toBe('legacy-easy-id');
    });

    // Linus review #6 — pin behavior when a persona declares a difficulty but
    // assistantEnvVars lacks a key for it. Optional-chain on `assistantEnvVars?.[difficulty]`
    // returns undefined → falls through to legacy. Correct, but pinned so a
    // future refactor that swaps the optional-chain doesn't silently change it.
    test('falls back to legacy when assistantEnvVars lacks the difficulty key', () => {
      const fs = require('fs');
      const fakePersona = JSON.stringify([{
        id: 'partial',
        displayName: 'Partial',
        role: 'Test fixture',
        summary: 'Has difficulty list but missing key in assistantEnvVars',
        difficulties: ['easy', 'expert'],
        assistantEnvVars: { easy: 'VAPI_SIM_PARTIAL_EASY_ID' },
      }]);
      const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
        if (String(p).endsWith('personas.json')) return fakePersona;
        return jest.requireActual('fs').readFileSync(p, ...rest);
      });
      try {
        _resetCache();
        process.env.VAPI_SIM_EXPERT_ID = 'legacy-expert';
        delete process.env.VAPI_SIM_PARTIAL_EXPERT_ID;
        expect(resolveAssistantId({ personaId: 'partial', difficulty: 'expert' })).toBe('legacy-expert');
      } finally {
        spy.mockRestore();
        _resetCache();
      }
    });
  });

  describe('validatePersonaConfig()', () => {
    test('returns 0 when every slot resolves', () => {
      process.env.VAPI_SIM_MIKE_GARZA_EASY_ID = 'e';
      process.env.VAPI_SIM_MIKE_GARZA_MEDIUM_ID = 'm';
      process.env.VAPI_SIM_MIKE_GARZA_HARD_ID = 'h';
      expect(validatePersonaConfig()).toBe(0);
    });

    test('returns the count of unresolved slots and warns per slot', () => {
      delete process.env.VAPI_SIM_MIKE_GARZA_EASY_ID;
      delete process.env.VAPI_SIM_MIKE_GARZA_MEDIUM_ID;
      delete process.env.VAPI_SIM_MIKE_GARZA_HARD_ID;
      delete process.env.VAPI_SIM_EASY_ID;
      delete process.env.VAPI_SIM_MEDIUM_ID;
      delete process.env.VAPI_SIM_HARD_ID;
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(validatePersonaConfig()).toBe(3);
      expect(warn).toHaveBeenCalledTimes(3);
      warn.mockRestore();
    });
  });
});
