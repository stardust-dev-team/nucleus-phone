const { Router } = require('express');
const { pool } = require('../db');

const router = Router();

// GET /api/equipment/search?q=haas — text search across manufacturer + model
router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q parameter required' });

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

  try {
    const escaped = q.replace(/[%_\\]/g, '\\$&');
    const pattern = `%${escaped}%`;
    const { rows } = await pool.query(
      `SELECT ec.*, ed.description, ed.air_usage_notes, ed.recommended_compressor,
              ed.recommended_dryer, ed.system_notes, ed.key_selling_points
       FROM equipment_catalog ec
       LEFT JOIN equipment_details ed ON ed.equipment_id = ec.id
       WHERE ec.manufacturer ILIKE $1 ESCAPE '\\' OR ec.model ILIKE $1 ESCAPE '\\'
         OR EXISTS (SELECT 1 FROM unnest(COALESCE(ec.model_variants, '{}')) v WHERE v ILIKE $1 ESCAPE '\\')
       ORDER BY ec.manufacturer, ec.model
       LIMIT $2`,
      [pattern, limit]
    );
    res.json({ results: rows, count: rows.length });
  } catch (err) {
    console.error('equipment search error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/equipment/unverified — entries with confidence='unverified' (admin review queue)
router.get('/unverified', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

  try {
    const { rows } = await pool.query(
      `SELECT ec.*, ed.description, ed.air_usage_notes, ed.system_notes
       FROM equipment_catalog ec
       LEFT JOIN equipment_details ed ON ed.equipment_id = ec.id
       WHERE ec.confidence = 'unverified'
       ORDER BY ec.created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ results: rows, count: rows.length });
  } catch (err) {
    console.error('equipment unverified error:', err.message);
    res.status(500).json({ error: 'Query failed' });
  }
});

// GET /api/equipment/sightings?resolved=false — equipment sightings log
router.get('/sightings', async (req, res) => {
  const resolved = req.query.resolved === 'true';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

  try {
    const { rows } = await pool.query(
      `SELECT es.*, ec.manufacturer AS catalog_manufacturer, ec.model AS catalog_model,
              ec.cfm_typical AS catalog_cfm
       FROM equipment_sightings es
       LEFT JOIN equipment_catalog ec ON ec.id = es.catalog_match_id
       WHERE es.resolved = $1
       ORDER BY es.count DESC, es.created_at DESC
       LIMIT $2`,
      [resolved, limit]
    );
    res.json({ results: rows, count: rows.length });
  } catch (err) {
    console.error('equipment sightings error:', err.message);
    res.status(500).json({ error: 'Query failed' });
  }
});

// NOTE: Parameterized routes (/:id) must come AFTER static paths (/search, /unverified, /sightings)

// PUT /api/equipment/:id/verify — admin marks entry as verified
router.put('/:id/verify', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

  const verifiedBy = req.user?.identity || req.user?.name || 'admin';

  try {
    const { rows } = await pool.query(
      `UPDATE equipment_catalog
       SET confidence = 'high', verified_by = $1, last_verified_at = NOW(), updated_at = NOW()
       WHERE id = $2
       RETURNING id, manufacturer, model, confidence, verified_by, last_verified_at`,
      [verifiedBy, id]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Equipment not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('equipment verify error:', err.message);
    res.status(500).json({ error: 'Verify failed' });
  }
});

// GET /api/equipment/:id — single equipment detail
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

  try {
    const { rows } = await pool.query(
      `SELECT ec.*, ed.description, ed.typical_applications, ed.industries,
              ed.air_usage_notes, ed.common_air_problems, ed.recommended_air_quality,
              ed.recommended_compressor, ed.recommended_dryer, ed.recommended_filters,
              ed.system_notes, ed.key_selling_points, ed.common_objections
       FROM equipment_catalog ec
       LEFT JOIN equipment_details ed ON ed.equipment_id = ec.id
       WHERE ec.id = $1`,
      [id]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Equipment not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('equipment get error:', err.message);
    res.status(500).json({ error: 'Query failed' });
  }
});

module.exports = router;
