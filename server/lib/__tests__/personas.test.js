const { listPersonas, resolveAssistantId, validatePersonaConfig, activePersonaId, getPersona, _resetCache } = require('../personas');

describe('lib/personas', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    _resetCache();
  });

  describe('listPersonas()', () => {
    test('returns the registered personas (mike-garza + ksi-dave)', () => {
      const personas = listPersonas();
      expect(personas).toHaveLength(2);
      const byId = Object.fromEntries(personas.map((p) => [p.id, p]));
      expect(byId['mike-garza']).toMatchObject({
        id: 'mike-garza',
        displayName: 'Mike Garza',
        difficulties: ['easy', 'medium', 'hard'],
      });
      expect(byId['ksi-dave']).toMatchObject({
        id: 'ksi-dave',
        displayName: 'Dave Kowalski',
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
      process.env.VAPI_SIM_KSI_EASY_ID = 'ke';
      process.env.VAPI_SIM_KSI_MEDIUM_ID = 'km';
      process.env.VAPI_SIM_KSI_HARD_ID = 'kh';
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
      // 2 personas × 3 difficulties, all unresolved (assets all present).
      expect(validatePersonaConfig()).toBe(6);
      expect(warn).toHaveBeenCalledTimes(6);
      warn.mockRestore();
    });

    // Linus review #1 — a persona registered in personas.json but missing its
    // greeting pool / base cockpit contact / prompt files must surface LOUD at
    // boot, not silently mid-call (a missing greeting pool opens a call with the
    // WRONG persona's identity). Pin that validatePersonaConfig counts each.
    test('counts a persona with no greeting pool, no base contact, and no prompt files', () => {
      const fs = require('fs');
      const fakePersona = JSON.stringify([{
        id: 'ghost',
        displayName: 'Ghost',
        role: 'Test fixture',
        summary: 'Registered but has zero assets on disk / in greeting pools',
        difficulties: ['easy'],
        assistantEnvVars: { easy: 'VAPI_SIM_GHOST_EASY_ID' },
      }]);
      const realFs = jest.requireActual('fs');
      const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
        if (String(p).endsWith('personas.json')) return fakePersona;
        return realFs.readFileSync(p, ...rest);
      });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        _resetCache();
        process.env.VAPI_SIM_GHOST_EASY_ID = 'g'; // assistant slot resolves — isolate the asset checks
        // Expect 3 misses: greeting pool, base contact json, prompt txt.
        expect(validatePersonaConfig()).toBe(3);
      } finally {
        warn.mockRestore();
        spy.mockRestore();
        _resetCache();
      }
    });
  });

  describe('activePersonaId()', () => {
    test('defaults to mike-garza when SIM_ACTIVE_PERSONA is unset', () => {
      delete process.env.SIM_ACTIVE_PERSONA;
      expect(activePersonaId()).toBe('mike-garza');
    });

    test('empty string is treated as unset', () => {
      process.env.SIM_ACTIVE_PERSONA = '';
      expect(activePersonaId()).toBe('mike-garza');
    });

    test('returns the env value when it names a known persona', () => {
      process.env.SIM_ACTIVE_PERSONA = 'ksi-dave';
      expect(activePersonaId()).toBe('ksi-dave');
    });

    test('falls back to mike-garza and warns once for an unknown persona', () => {
      process.env.SIM_ACTIVE_PERSONA = 'nobody';
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(activePersonaId()).toBe('mike-garza');
      expect(activePersonaId()).toBe('mike-garza');
      expect(warn).toHaveBeenCalledTimes(1); // one-time warn
      warn.mockRestore();
    });
  });

  describe('getPersona()', () => {
    test('returns the full record (incl. assistantEnvVars) for a known id', () => {
      const p = getPersona('ksi-dave');
      expect(p).toMatchObject({
        id: 'ksi-dave',
        displayName: 'Dave Kowalski',
        assistantEnvVars: {
          easy: 'VAPI_SIM_KSI_EASY_ID',
          medium: 'VAPI_SIM_KSI_MEDIUM_ID',
          hard: 'VAPI_SIM_KSI_HARD_ID',
        },
      });
    });

    test('returns undefined for an unknown id', () => {
      expect(getPersona('who-dis')).toBeUndefined();
    });
  });
});
