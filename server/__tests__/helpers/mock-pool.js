/**
 * Shared mock factory for the pg Pool used throughout the server.
 *
 * Usage in test files:
 *   jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
 *   const { pool } = require('../../db');
 *   // pool.query is a jest.fn() you can configure per test
 */
module.exports = function createMockDb() {
  return {
    pool: {
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      connect: jest.fn().mockResolvedValue({
        query: jest.fn(),
        release: jest.fn(),
      }),
    },
    initSchema: jest.fn(),
  };
};
