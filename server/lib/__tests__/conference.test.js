const conference = require('../conference');
const {
  createConference, getConference, updateConference,
  removeConference, listActiveConferences, claimLeadDial,
} = conference;

const CONF_NAME = 'test-conf-001';
const CONF_DATA = {
  callerIdentity: 'tom',
  to: '+18005551234',
  contactName: 'Jane Doe',
  companyName: 'Acme Corp',
  contactId: 'hs-123',
  dbRowId: 42,
};

afterEach(() => {
  // Clean up module-level Map between tests
  removeConference(CONF_NAME);
  removeConference('conf-a');
  removeConference('conf-b');
});

describe('CRUD operations', () => {
  test('createConference stores and getConference retrieves', () => {
    createConference(CONF_NAME, CONF_DATA);
    const conf = getConference(CONF_NAME);
    expect(conf).toBeTruthy();
    expect(conf.startedBy).toBe('tom');
    expect(conf.leadPhone).toBe('+18005551234');
    expect(conf.conferenceSid).toBeNull();
    expect(conf.leadDialed).toBe(false);
  });

  test('getConference returns undefined for missing name', () => {
    expect(getConference('nonexistent')).toBeUndefined();
  });

  test('updateConference merges fields', () => {
    createConference(CONF_NAME, CONF_DATA);
    updateConference(CONF_NAME, { conferenceSid: 'CF123', participants: ['tom'] });
    const conf = getConference(CONF_NAME);
    expect(conf.conferenceSid).toBe('CF123');
    expect(conf.participants).toEqual(['tom']);
    expect(conf.leadPhone).toBe('+18005551234'); // original preserved
  });

  test('updateConference on missing name is a no-op', () => {
    expect(() => updateConference('ghost', { conferenceSid: 'X' })).not.toThrow();
  });

  test('removeConference deletes the entry', () => {
    createConference(CONF_NAME, CONF_DATA);
    removeConference(CONF_NAME);
    expect(getConference(CONF_NAME)).toBeUndefined();
  });

  test('listActiveConferences returns all', () => {
    createConference('conf-a', CONF_DATA);
    createConference('conf-b', CONF_DATA);
    const list = listActiveConferences();
    expect(list).toHaveLength(2);
    expect(list.map(c => c.conferenceName).sort()).toEqual(['conf-a', 'conf-b']);
  });
});

describe('claimLeadDial', () => {
  test('first call returns true, second returns false (no double-dial)', () => {
    createConference(CONF_NAME, CONF_DATA);
    expect(claimLeadDial(CONF_NAME)).toBe(true);
    expect(claimLeadDial(CONF_NAME)).toBe(false);
  });

  test('returns false for nonexistent conference', () => {
    expect(claimLeadDial('nonexistent')).toBe(false);
  });
});

describe('stale conference cleanup', () => {
  let conferenceModule;

  beforeAll(() => {
    jest.useFakeTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    // Require a fresh module instance so the setInterval uses fake timers
    jest.isolateModules(() => {
      conferenceModule = require('../conference');
    });
  });

  afterEach(() => {
    // Clean up any conferences
    for (const c of conferenceModule.listActiveConferences()) {
      conferenceModule.removeConference(c.conferenceName);
    }
  });

  test('removes conferences with no SID after 5 minutes', () => {
    conferenceModule.createConference('stale-no-sid', CONF_DATA);
    // conferenceSid is null by default — simulate 5+ min passing
    jest.advanceTimersByTime(5 * 60 * 1000 + 1);
    // The sweep runs every 2 min, so advance past a sweep cycle
    jest.advanceTimersByTime(2 * 60 * 1000);
    expect(conferenceModule.getConference('stale-no-sid')).toBeUndefined();
  });

  test('keeps conferences with SID under 2 hours', () => {
    conferenceModule.createConference('active-conf', CONF_DATA);
    conferenceModule.updateConference('active-conf', { conferenceSid: 'CF999' });
    jest.advanceTimersByTime(30 * 60 * 1000); // 30 min
    expect(conferenceModule.getConference('active-conf')).toBeTruthy();
    conferenceModule.removeConference('active-conf');
  });

  test('removes conferences older than 2 hours regardless of SID', () => {
    conferenceModule.createConference('ancient-conf', CONF_DATA);
    conferenceModule.updateConference('ancient-conf', { conferenceSid: 'CF999' });
    jest.advanceTimersByTime(2 * 60 * 60 * 1000 + 1);
    jest.advanceTimersByTime(2 * 60 * 1000);
    expect(conferenceModule.getConference('ancient-conf')).toBeUndefined();
  });
});
