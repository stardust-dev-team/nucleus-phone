jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../hubspot');
jest.mock('../apollo');
jest.mock('../dropcontact');

const { pool } = require('../../db');
const hubspot = require('../hubspot');
const apollo = require('../apollo');
const dropcontact = require('../dropcontact');
const { resolve } = require('../identity-resolver');

const HS_CONTACT = {
  id: '12345',
  properties: {
    firstname: 'Jane',
    lastname: 'Doe',
    company: 'Acme Corp',
    phone: '+16305551234',
    email: 'jane@acme.com',
    jobtitle: 'VP Ops',
    associatedcompanyid: '99',
    joruva_fit_score: '85',
    joruva_fit_reason: 'ICP match',
    joruva_persona: 'operator',
  },
};

const PB_ROW = {
  full_name: 'Jane Doe',
  first_name: 'jane',
  last_name: 'doe',
  title: 'VP Operations',
  linkedin_profile_url: 'https://linkedin.com/in/janedoe',
  profile_image: 'https://img.example.com/jane.jpg',
  summary: '20yr ops leader',
  duration_in_role: '3 years',
  duration_in_company: '5 years',
  connection_degree: '2nd',
  past_company: 'OldCorp',
  past_title: 'Director',
};

beforeEach(() => {
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  hubspot.findContactByPhone.mockResolvedValue(null);
  hubspot.getContact.mockResolvedValue(null);
  hubspot.searchContacts.mockResolvedValue({ total: 0, results: [] });
  apollo.matchPerson.mockResolvedValue(null);
  dropcontact.reverseSearch.mockResolvedValue({ email: null, qualification: null });
});

describe('classifyIdentifier + resolve routing', () => {
  test('null/empty identifier returns unresolved', async () => {
    const result = await resolve('');
    expect(result.resolved).toBe(false);
    expect(result.source).toBe('unknown');
  });

  test('phone identifier calls findContactByPhone', async () => {
    hubspot.findContactByPhone.mockResolvedValue(HS_CONTACT);
    await resolve('+1 (630) 555-1234');
    expect(hubspot.findContactByPhone).toHaveBeenCalledWith('+1 (630) 555-1234');
  });

  test('numeric identifier calls getContact (HubSpot ID)', async () => {
    hubspot.getContact.mockResolvedValue(HS_CONTACT);
    await resolve('357584127732');
    expect(hubspot.getContact).toHaveBeenCalledWith('357584127732');
  });

  test('email identifier calls searchContacts', async () => {
    hubspot.searchContacts.mockResolvedValue({ total: 1, results: [HS_CONTACT] });
    await resolve('jane@acme.com');
    expect(hubspot.searchContacts).toHaveBeenCalledWith('jane@acme.com', 1);
  });

  test('gibberish identifier returns unresolved', async () => {
    const result = await resolve('not-a-valid-id');
    expect(result.resolved).toBe(false);
  });
});

describe('Step 1: HubSpot resolution', () => {
  test('returns hubspot source with full properties', async () => {
    hubspot.findContactByPhone.mockResolvedValue(HS_CONTACT);
    const result = await resolve('+16305551234');

    expect(result.resolved).toBe(true);
    expect(result.source).toBe('hubspot');
    expect(result.hubspotContactId).toBe('12345');
    expect(result.hubspotCompanyId).toBe('99');
    expect(result.name).toBe('Jane Doe');
    expect(result.email).toBe('jane@acme.com');
    expect(result.company).toBe('Acme Corp');
    expect(result.fitScore).toBe('85');
    expect(result.persona).toBe('operator');
  });

  test('HubSpot error is caught — does not throw', async () => {
    hubspot.findContactByPhone.mockRejectedValue(new Error('API down'));
    const result = await resolve('+16305551234');
    expect(result.resolved).toBe(false);
  });
});

describe('Step 2: PB contacts lookup', () => {
  test('queries PB when HubSpot provides company + name', async () => {
    hubspot.findContactByPhone.mockResolvedValue(HS_CONTACT);
    pool.query.mockResolvedValue({ rows: [PB_ROW], rowCount: 1 });

    const result = await resolve('+16305551234');
    expect(result.pbContactData).not.toBeNull();
    expect(result.pbContactData.summary).toBe('20yr ops leader');
    expect(result.linkedinUrl).toBe('https://linkedin.com/in/janedoe');
    expect(result.profileImage).toBe('https://img.example.com/jane.jpg');
  });

  test('PB returns >5 rows with no name match → null pbContactData', async () => {
    hubspot.findContactByPhone.mockResolvedValue(HS_CONTACT);
    const noMatchRows = Array.from({ length: 6 }, (_, i) => ({
      ...PB_ROW, full_name: `Other Person ${i}`, first_name: 'other', last_name: `person${i}`,
    }));
    pool.query.mockResolvedValue({ rows: noMatchRows, rowCount: 6 });

    const result = await resolve('+16305551234');
    expect(result.pbContactData).toBeNull();
  });

  test('PB exact full-name match wins over partial', async () => {
    hubspot.findContactByPhone.mockResolvedValue(HS_CONTACT);
    pool.query.mockResolvedValue({
      rows: [
        { ...PB_ROW, full_name: 'Jane Smith', first_name: 'jane', last_name: 'smith', title: 'Wrong Person' },
        { ...PB_ROW, full_name: 'Jane Doe', first_name: 'jane', last_name: 'doe', title: 'VP Operations' },
      ],
      rowCount: 2,
    });

    const result = await resolve('+16305551234');
    expect(result.pbContactData.summary).toBe('20yr ops leader');
  });
});

describe('Step 3: Apollo (credit-gated)', () => {
  beforeEach(() => {
    hubspot.findContactByPhone.mockResolvedValue(HS_CONTACT);
    pool.query.mockImplementation((sql) => {
      if (sql.includes('v35_pb_contacts')) return { rows: [], rowCount: 0 };
      if (sql.includes('ucil_sync_state')) {
        return { rows: [{ metadata: { date: new Date().toISOString().slice(0, 10), credits_used: 1 } }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  });

  test('calls Apollo when PB has no LinkedIn and budget available', async () => {
    apollo.matchPerson.mockResolvedValue({
      linkedin_url: 'https://linkedin.com/in/janedoe',
      title: 'VP Operations',
      email: 'jane@acme.com',
    });

    const result = await resolve('+16305551234');
    expect(apollo.matchPerson).toHaveBeenCalledWith(expect.objectContaining({
      firstName: 'Jane',
      lastName: 'Doe',
      organization: 'Acme Corp',
    }));
    expect(result.linkedinUrl).toBe('https://linkedin.com/in/janedoe');
  });

  test('skips Apollo when credit budget exhausted', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('v35_pb_contacts')) return { rows: [], rowCount: 0 };
      if (sql.includes('ucil_sync_state')) {
        return { rows: [{ metadata: { date: new Date().toISOString().slice(0, 10), credits_used: 10 } }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await resolve('+16305551234');
    expect(apollo.matchPerson).not.toHaveBeenCalled();
  });

  test('Apollo error is caught gracefully', async () => {
    apollo.matchPerson.mockRejectedValue(new Error('rate limited'));
    const result = await resolve('+16305551234');
    expect(result.resolved).toBe(true);
    expect(result.source).toBe('hubspot');
  });
});

describe('Step 4: Dropcontact (credit-gated)', () => {
  test('calls Dropcontact when no email from Steps 1-3', async () => {
    hubspot.findContactByPhone.mockResolvedValue({
      id: '1',
      properties: { firstname: 'Jane', lastname: 'Doe', company: 'Acme', phone: '+16305551234' },
    });
    pool.query.mockImplementation((sql) => {
      if (sql.includes('v35_pb_contacts')) return { rows: [], rowCount: 0 };
      if (sql.includes('ucil_sync_state')) {
        return { rows: [{ metadata: { date: new Date().toISOString().slice(0, 10), credits_used: 1 } }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    dropcontact.reverseSearch.mockResolvedValue({ email: 'jane@acme.com', qualification: 'valid' });
    const result = await resolve('+16305551234');
    expect(dropcontact.reverseSearch).toHaveBeenCalled();
    expect(result.email).toBe('jane@acme.com');
  });

  test('skips Dropcontact when email already found', async () => {
    hubspot.findContactByPhone.mockResolvedValue(HS_CONTACT);
    pool.query.mockImplementation((sql) => {
      if (sql.includes('v35_pb_contacts')) return { rows: [], rowCount: 0 };
      if (sql.includes('ucil_sync_state')) {
        return { rows: [{ metadata: { date: new Date().toISOString().slice(0, 10), credits_used: 1 } }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await resolve('+16305551234');
    expect(dropcontact.reverseSearch).not.toHaveBeenCalled();
  });
});

describe('full pipeline', () => {
  test('all steps null → unresolved', async () => {
    const result = await resolve('+10000000000');
    expect(result.resolved).toBe(false);
    expect(result.source).toBe('unknown');
  });

  test('source priority: hubspot when HS found', async () => {
    hubspot.findContactByPhone.mockResolvedValue(HS_CONTACT);
    pool.query.mockResolvedValue({ rows: [PB_ROW], rowCount: 1 });
    const result = await resolve('+16305551234');
    expect(result.source).toBe('hubspot');
  });
});
