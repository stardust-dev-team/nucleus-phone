const { Router } = require('express');
const msal = require('@azure/msal-node');
const jwt = require('jsonwebtoken');
const { sessionAuth } = require('../middleware/auth');

const router = Router();

// Email → { identity, role } mapping. Only @joruva.com emails allowed.
const USER_MAP = {
  'tom@joruva.com': { identity: 'tom', role: 'admin' },
  'paul@joruva.com': { identity: 'paul', role: 'admin' },
  'kate@joruva.com': { identity: 'kate', role: 'caller' },
  'britt@joruva.com': { identity: 'britt', role: 'caller' },
  'ryann@joruva.com': { identity: 'ryann', role: 'caller' },
  'alex@joruva.com': { identity: 'alex', role: 'caller' },
};

// Valid Twilio identities — used by token endpoint to reject arbitrary strings.
const VALID_IDENTITIES = new Set(Object.values(USER_MAP).map(u => u.identity));

const SCOPES = ['User.Read', 'openid', 'profile', 'email'];

let msalApp;

function getMsalApp() {
  if (!msalApp) {
    msalApp = new msal.ConfidentialClientApplication({
      auth: {
        clientId: process.env.ENTRA_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}`,
        clientSecret: process.env.ENTRA_CLIENT_SECRET,
      },
    });
  }
  return msalApp;
}

function getAppUrl() {
  return process.env.APP_URL || 'http://localhost:3001';
}

function getRedirectUri() {
  return `${getAppUrl()}/api/auth/callback`;
}

// GET /api/auth/login — redirect to Microsoft login
router.get('/login', async (req, res) => {
  try {
    const url = await getMsalApp().getAuthCodeUrl({
      scopes: SCOPES,
      redirectUri: getRedirectUri(),
    });
    res.redirect(url);
  } catch (err) {
    console.error('MSAL auth URL failed:', err.message);
    res.status(500).send('Login failed');
  }
});

// GET /api/auth/callback — Microsoft OAuth callback
router.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No auth code');

  try {
    const result = await getMsalApp().acquireTokenByCode({
      code,
      scopes: SCOPES,
      redirectUri: getRedirectUri(),
    });

    const claims = result.idTokenClaims || {};
    const email = (claims.preferred_username || claims.email || '').toLowerCase();
    const tid = claims.tid;

    // Validate tenant
    if (tid !== process.env.ENTRA_TENANT_ID) {
      return res.status(403).send('Invalid tenant');
    }

    // Validate domain
    if (!email.endsWith('@joruva.com')) {
      return res.status(403).send('Only joruva.com accounts are allowed');
    }

    // Look up user
    const user = USER_MAP[email];
    if (!user) {
      return res.status(403).send(`No Nucleus Phone account for ${email}`);
    }

    // Create session
    const token = jwt.sign(
      { identity: user.identity, role: user.role, email },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.cookie('nucleus_session', token, {
      httpOnly: true,
      secure: getAppUrl().startsWith('https'),
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    });

    res.redirect('/');
  } catch (err) {
    console.error('MSAL token exchange failed:', err.message);
    res.status(500).send('Authentication failed');
  }
});

// GET /api/auth/me — return current user from session cookie
router.get('/me', sessionAuth, (req, res) => {
  res.json(req.user);
});

// POST /api/auth/logout — clear session cookie
router.post('/logout', (req, res) => {
  res.clearCookie('nucleus_session');
  res.json({ ok: true });
});

module.exports = Object.assign(router, { VALID_IDENTITIES });
