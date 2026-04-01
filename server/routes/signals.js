/**
 * Signal data proxy — fetches signal data from multichannel's ABM API.
 * GET /api/signals/:domain
 */

const express = require('express');
const router = express.Router();

const MC_BASE = process.env.MULTICHANNEL_API_URL || 'https://joruva-multichannel.onrender.com';
const MC_API_KEY = process.env.MC_API_KEY || '';

// GET /api/signals/:domain — proxy to multichannel's /admin/abm/account/:domain/signals
router.get('/:domain', async (req, res) => {
  const { domain } = req.params;
  if (!domain) return res.status(400).json({ error: 'domain required' });

  try {
    const url = `${MC_BASE}/admin/abm/account/${encodeURIComponent(domain)}/signals`;
    const resp = await fetch(url, {
      headers: MC_API_KEY ? { 'x-api-key': MC_API_KEY } : {},
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      if (resp.status === 404) return res.json({ account: null, signal_metadata: null, recent_signals: [] });
      return res.status(resp.status).json({ error: `multichannel API returned ${resp.status}` });
    }

    const data = await resp.json();
    res.json(data);
  } catch (err) {
    console.error('signals proxy error:', err.message);
    // Graceful degradation: cockpit works without signals
    res.json({ account: null, signal_metadata: null, recent_signals: [] });
  }
});

// GET /api/signals/pipeline — batch pipeline view for team work queue
router.get('/pipeline', async (req, res) => {
  try {
    const { signal_tier, geo_state, limit = '100' } = req.query;
    const params = new URLSearchParams();
    if (signal_tier) params.set('signal_tier', signal_tier);
    if (geo_state) params.set('geo_state', geo_state);
    params.set('limit', limit);

    // This calls UCIL's record assembler batch endpoint if available,
    // or falls back to direct DB query via multichannel
    const url = `${MC_BASE}/admin/abm/accounts?${params}`;
    const resp = await fetch(url, {
      headers: MC_API_KEY ? { 'x-api-key': MC_API_KEY } : {},
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) return res.json({ companies: [] });
    const data = await resp.json();
    res.json({ companies: data.accounts || [] });
  } catch (err) {
    console.error('pipeline proxy error:', err.message);
    res.json({ companies: [] });
  }
});

module.exports = router;
