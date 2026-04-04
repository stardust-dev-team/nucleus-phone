const { pool } = require('../db');
const { encrypt, decrypt } = require('./crypto');
const { USER_MAP } = require('../routes/auth');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_URL = `https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}/oauth2/v2.0/token`;

/**
 * Get a valid Graph API access token for a specific rep's mailbox.
 * Uses direct token endpoint refresh (not MSAL) inside an explicit DB transaction
 * with FOR UPDATE to prevent concurrent refresh token clobber.
 */
async function getTokenForUser(email) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT cache_data, home_account_id FROM msal_token_cache WHERE partition_key = $1 FOR UPDATE',
      [email]
    );

    if (rows.length === 0) {
      throw new Error(`No MSAL cache for ${email} — user must re-login to enable email sending`);
    }

    const cacheJson = decrypt(rows[0].cache_data);
    const cache = JSON.parse(cacheJson);
    const homeAccountId = rows[0].home_account_id;

    // Extract refresh token by home_account_id (username is undefined in MSAL cache)
    const rtEntry = Object.values(cache.RefreshToken || {})
      .find(entry => entry.home_account_id === homeAccountId);

    if (!rtEntry?.secret) {
      throw new Error(`No refresh token found in MSAL cache for ${email} — user must re-login`);
    }

    // Call token endpoint directly
    const body = new URLSearchParams({
      client_id: process.env.ENTRA_CLIENT_ID,
      client_secret: process.env.ENTRA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: rtEntry.secret,
      scope: 'Mail.Send offline_access',
    });

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const errorCode = err.error;
      if (res.status === 400 && (errorCode === 'invalid_grant' || errorCode === 'interaction_required')) {
        throw new Error(`Refresh token expired for ${email} — user must re-login`);
      }
      throw new Error(`Token refresh failed for ${email}: ${res.status} ${errorCode || res.statusText}`);
    }

    const tokenData = await res.json();

    // Update the refresh token in the cached MSAL blob (it may have rotated)
    if (tokenData.refresh_token) {
      rtEntry.secret = tokenData.refresh_token;
      const updatedCacheJson = JSON.stringify(cache);
      const encrypted = encrypt(updatedCacheJson);
      await client.query(
        'UPDATE msal_token_cache SET cache_data = $1, updated_at = NOW() WHERE partition_key = $2',
        [encrypted, email]
      );
    }

    await client.query('COMMIT');
    return tokenData.access_token;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Build the follow-up email HTML based on qualification level.
 * Warm Authority register — no hedging, no "I hope this finds you well."
 */
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildEmail({ leadName, leadCompany, products, callerName, qualification }) {
  const firstName = escapeHtml(leadName?.split(' ')[0] || '');
  const company = escapeHtml(leadCompany);
  const safeCaller = escapeHtml(callerName);
  const productList = (products || []).filter(Boolean).map(escapeHtml);

  if (qualification === 'hot') {
    return {
      subject: `${safeCaller} from Joruva — your quote for ${company || 'your shop'}`,
      body: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #222; max-width: 580px; line-height: 1.6;">
  <p>${firstName},</p>
  <p>Good talking with you${leadCompany ? ` about what's running at ${company}` : ''}. Based on what you described, I'm putting together a quote for ${productList.length ? productList.join(', ') : 'the equipment we discussed'}.</p>
  <p>I'll include the compliance documentation package — everything your auditor would need on the air system side. Expect that in your inbox shortly.</p>
  <p>One call to size it right. That's the whole idea.</p>
  <p>${safeCaller}<br>Joruva Industrial</p>
</div>`,
    };
  }

  if (qualification === 'warm') {
    return {
      subject: `${safeCaller} from Joruva — specs we discussed`,
      body: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #222; max-width: 580px; line-height: 1.6;">
  <p>${firstName},</p>
  <p>Thanks for the conversation${leadCompany ? ` about ${company}'s setup` : ''}. I'm sending over the spec sheets for ${productList.length ? productList.join(', ') : 'the equipment we covered'} so you have everything in one place.</p>
  <p>No rush on any of this. When the timing is right, we're here to size it to your actual demand.</p>
  <p>${safeCaller}<br>Joruva Industrial</p>
</div>`,
    };
  }

  // info_only or fallback
  return {
    subject: `Good talking with you — ${safeCaller} from Joruva`,
    body: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #222; max-width: 580px; line-height: 1.6;">
  <p>${firstName},</p>
  <p>Appreciate your time today. If anything comes up on the compressed air side, you've got a direct line.</p>
  <p>${safeCaller}<br>Joruva Industrial</p>
</div>`,
  };
}

/**
 * Send a follow-up email from the rep's own mailbox via Graph API.
 */
async function sendFollowUpEmail({ fromEmail, toEmail, leadName, leadCompany, products, callerIdentity, qualification }) {
  const user = USER_MAP[fromEmail];
  const callerName = user?.displayName || callerIdentity;

  const accessToken = await getTokenForUser(fromEmail);
  const { subject, body } = buildEmail({ leadName, leadCompany, products, callerName, qualification });

  const res = await fetch(`${GRAPH_BASE}/me/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: body },
        toRecipients: [{ emailAddress: { address: toEmail, name: leadName || toEmail } }],
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph sendMail failed: ${res.status} ${err.substring(0, 300)}`);
  }

  console.log(`[email] Follow-up sent from ${fromEmail} → ${toEmail} (${qualification})`);
  return { sent: true };
}

module.exports = { getTokenForUser, sendFollowUpEmail };
