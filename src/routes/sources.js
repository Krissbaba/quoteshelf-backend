import express from 'express';
import { body, query as vQuery, validationResult } from 'express-validator';
import { query } from '../db/pool.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';

const router = express.Router();

// GET /api/sources?search=...&genre=...&type=...&year=...
router.get('/', optionalAuth, async (req, res) => {
  const { search, genre, type, year, limit = 20, offset = 0 } = req.query;

  try {
    let sql = `
      SELECT s.*,
        COUNT(q.id) as quote_count,
        u.username as added_by_username
      FROM sources s
      LEFT JOIN quotes q ON q.source_id = s.id AND q.is_public = true
      LEFT JOIN users u ON u.id = s.created_by
    `;
    const params = [];
    const conditions = [];

    if (search) {
      params.push(search);
      conditions.push(`s.search_vec @@ plainto_tsquery('english', $${params.length})`);
    }
    if (genre) {
      params.push(genre.toLowerCase());
      conditions.push(`LOWER(s.genre) = $${params.length}`);
    }
    if (type) {
      params.push(type.toLowerCase());
      conditions.push(`LOWER(s.type) = $${params.length}`);
    }
    if (year) {
      params.push(parseInt(year));
      conditions.push(`s.year = $${params.length}`);
    }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' GROUP BY s.id, u.username';
    if (search) {
      params.push(search);
      sql += ` ORDER BY ts_rank(s.search_vec, plainto_tsquery('english', $${params.length})) DESC`;
    } else {
      sql += ' ORDER BY s.title ASC';
    }
    params.push(parseInt(limit), parseInt(offset));
    sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await query(sql, params);
    res.json({ sources: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/sources/:id
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT s.*, u.username as added_by_username,
        COUNT(q.id) as quote_count
       FROM sources s
       LEFT JOIN users u ON u.id = s.created_by
       LEFT JOIN quotes q ON q.source_id = s.id AND q.is_public = true
       WHERE s.id = $1
       GROUP BY s.id, u.username`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Source not found' });
    res.json({ source: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/sources
router.post('/', requireAuth, [
  body('title').trim().notEmpty().isLength({ max: 500 }),
  body('author').optional().trim().isLength({ max: 500 }),
  body('year').optional().isInt({ min: -3000, max: 2100 }),
  body('genre').optional().trim().isLength({ max: 100 }),
  body('type').optional().isIn(['book', 'article', 'poem', 'speech', 'play', 'other']),
  body('isbn').optional().trim(),
  body('publisher').optional().trim().isLength({ max: 300 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });

  const { title, author, year, genre, type, isbn, publisher, cover_url } = req.body;

  try {
    // Check for duplicate
    const existing = await query(
      'SELECT id FROM sources WHERE LOWER(title) = LOWER($1) AND LOWER(COALESCE(author,\'\')) = LOWER(COALESCE($2,\'\'))',
      [title, author || '']
    );
    if (existing.rows[0]) {
      return res.status(409).json({ error: 'This source already exists', source_id: existing.rows[0].id });
    }

    const result = await query(
      `INSERT INTO sources (title, author, year, genre, type, isbn, publisher, cover_url, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [title, author, year, genre, type || 'book', isbn, publisher, cover_url, req.user.id]
    );
    res.status(201).json({ source: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/sources/:id/quotes
router.get('/:id/quotes', optionalAuth, async (req, res) => {
  const { limit = 20, offset = 0 } = req.query;
  try {
    const result = await query(
      `SELECT q.*, u.username, u.display_name, u.avatar_url,
        s.title as source_title, s.author as source_author,
        EXISTS(SELECT 1 FROM likes l WHERE l.quote_id = q.id AND l.user_id = $3) as liked_by_me,
        EXISTS(SELECT 1 FROM saved_quotes sv WHERE sv.quote_id = q.id AND sv.user_id = $3) as saved_by_me
       FROM quotes q
       JOIN users u ON u.id = q.user_id
       LEFT JOIN sources s ON s.id = q.source_id
       WHERE q.source_id = $1 AND q.is_public = true
       ORDER BY q.page_number NULLS LAST, q.line_number NULLS LAST, q.created_at DESC
       LIMIT $2 OFFSET $4`,
      [req.params.id, parseInt(limit), req.user?.id || null, parseInt(offset)]
    );
    res.json({ quotes: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
