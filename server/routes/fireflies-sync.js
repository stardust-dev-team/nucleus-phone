const { Router } = require('express');
const { apiKeyAuth } = require('../middleware/auth');
const { sync } = require('../lib/fireflies-sync');

const router = Router();

// POST /api/fireflies-sync — triggered by n8n cron every 30 min
router.post('/', apiKeyAuth, async (req, res) => {
  try {
    const result = await sync();
    res.json(result);
  } catch (err) {
    console.error('Fireflies sync endpoint failed:', err.message);
    res.status(500).json({ error: 'Sync failed', message: err.message });
  }
});

module.exports = router;
