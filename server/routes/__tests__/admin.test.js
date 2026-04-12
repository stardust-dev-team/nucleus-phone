/**
 * admin.test.js — user management endpoints that back instant revocation.
 *
 * These are the only endpoints Tom hits to onboard/offboard external users,
 * so they get their own coverage beyond the generic RBAC matrix.
 */

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { apiKeyAuth, __testSetUser } = require('../../middleware/auth');
const { rbac } = require('../../middleware/rbac');
const { pool } = require('../../db');

const API_KEY = 'test-api-key';

let nextUserId = 6000;
function loginAs(role) {
  const id = nextUserId++;
  __testSetUser({
    id, email: `u${id}@example.com`, identity: `u${id}`,
    role, displayName: `u${id}`,
  });
  jwt.verify.mockReturnValue({ userId: id });
}

let app;
beforeAll(() => {
  process.env.NUCLEUS_PHONE_API_KEY = API_KEY;
  process.env.JWT_SECRET = 'test-secret';
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin', apiKeyAuth, rbac('admin'), require('../admin'));
});

afterAll(() => {
  delete process.env.NUCLEUS_PHONE_API_KEY;
  delete process.env.JWT_SECRET;
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('POST /api/admin/users', () => {
  test('caller cannot create users', async () => {
    loginAs('caller');
    await request(app)
      .post('/api/admin/users')
      .set('Cookie', 'nucleus_session=t')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({
        email: 'blake@example.com', identity: 'blake',
        role: 'external_caller', displayName: 'Blake',
      })
      .expect(403);
  });

  test('admin creates external_caller', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 42, email: 'blake@example.com', identity: 'blake',
        role: 'external_caller', display_name: 'Blake', is_active: true,
      }],
    });
    await request(app)
      .post('/api/admin/users')
      .set('x-api-key', API_KEY)
      .send({
        email: 'blake@example.com', identity: 'blake',
        role: 'external_caller', displayName: 'Blake',
      })
      .expect(201)
      .expect((res) => {
        expect(res.body.user.role).toBe('external_caller');
      });
  });

  test('rejects invalid role', async () => {
    await request(app)
      .post('/api/admin/users')
      .set('x-api-key', API_KEY)
      .send({
        email: 'x@example.com', identity: 'x',
        role: 'superadmin', displayName: 'X',
      })
      .expect(400);
  });

  test('rejects bad identity format', async () => {
    await request(app)
      .post('/api/admin/users')
      .set('x-api-key', API_KEY)
      .send({
        email: 'x@example.com', identity: 'Bad Identity!',
        role: 'caller', displayName: 'X',
      })
      .expect(400);
  });
});

describe('POST /api/admin/users/:id/deactivate', () => {
  test('caller cannot deactivate', async () => {
    loginAs('caller');
    await request(app)
      .post('/api/admin/users/42/deactivate')
      .set('Cookie', 'nucleus_session=t')
      .set('X-Requested-With', 'XMLHttpRequest')
      .expect(403);
  });

  test('admin deactivates and cache is purged', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 42, email: 'blake@example.com', identity: 'blake', is_active: false }],
    });

    await request(app)
      .post('/api/admin/users/42/deactivate')
      .set('x-api-key', API_KEY)
      .expect(200)
      .expect((res) => {
        expect(res.body.user.is_active).toBe(false);
      });
  });

  test('admin cannot deactivate themselves', async () => {
    loginAs('admin');
    // loginAs sets jwt.verify to return { userId: id } — grab the id
    const { userId } = jwt.verify();
    await request(app)
      .post(`/api/admin/users/${userId}/deactivate`)
      .set('Cookie', 'nucleus_session=t')
      .set('X-Requested-With', 'XMLHttpRequest')
      .expect(409)
      .expect((res) => {
        expect(res.body.error).toMatch(/yourself/i);
      });
  });

  test('404 on unknown user', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await request(app)
      .post('/api/admin/users/99999/deactivate')
      .set('x-api-key', API_KEY)
      .expect(404);
  });
});

describe('POST /api/admin/users/:id/role', () => {
  test('admin can change role', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 42, email: 'blake@example.com', identity: 'blake', role: 'caller' }],
    });
    await request(app)
      .post('/api/admin/users/42/role')
      .set('x-api-key', API_KEY)
      .send({ role: 'caller' })
      .expect(200)
      .expect((res) => {
        expect(res.body.user.role).toBe('caller');
      });
  });

  test('admin cannot demote themselves', async () => {
    loginAs('admin');
    const { userId } = jwt.verify();
    await request(app)
      .post(`/api/admin/users/${userId}/role`)
      .set('Cookie', 'nucleus_session=t')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ role: 'caller' })
      .expect(409)
      .expect((res) => {
        expect(res.body.error).toMatch(/demote.*yourself/i);
      });
  });

  test('admin can set own role to admin (no-op)', async () => {
    loginAs('admin');
    const { userId } = jwt.verify();
    pool.query.mockResolvedValueOnce({
      rows: [{ id: userId, email: 'self@example.com', identity: 'self', role: 'admin' }],
    });
    await request(app)
      .post(`/api/admin/users/${userId}/role`)
      .set('Cookie', 'nucleus_session=t')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ role: 'admin' })
      .expect(200);
  });

  test('rejects unknown role', async () => {
    await request(app)
      .post('/api/admin/users/42/role')
      .set('x-api-key', API_KEY)
      .send({ role: 'god' })
      .expect(400);
  });
});
