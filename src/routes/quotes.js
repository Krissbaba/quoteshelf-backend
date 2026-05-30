import express from 'express';
import { body, validationResult } from 'express-validator';
import { query } from '../db/pool.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';

const router = express.Router();

// Full quote SELECT helper
const quoteSelect = (userId) => `
  SELECT
    q.*,
    u.username, u.display_name, u.avatar_url,
    s.title as source_title, s.author as source_author,
    s.year as source_year, s.genre as source_genre,
    s.type as source_type, s.cover_url as source_cover,
    EXISTS(SELECT 1 FROM likes l WHERE l.quote_id = q.id AND l.user_id = ${userId ? `'${userId}'` : 'NULL'}) as liked_by_me,
    EXISTS(SELECT 1 FROM saved_quotes sv WHERE sv.quote_id = q.id AND sv.user_id = ${userId ? `'${userId}'` : 'NULL'}) as saved_by_me
  FROM quotes q
  JOIN users u ON u.id = q.user_id
  LEFT JOIN sources s ON s.id = q.source_id
`;

// GET /api/quotes — public feed
router.get('/', optionalAuth, async (req, res) => {
  const { limit = 20, offset = 0 } = req.query;
  try {
    const result = await query(
      `${quoteSelect(req.user?.id)}
       WHERE q.is_public = true
       ORDER BY q.created_at DESC
       LIMIT $1 OFFSET $2`,
      [parseInt(limit), parseInt(offset)]
    );
    res.json({ quotes: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/quotes/search — full-text search
router.get('/search', optionalAuth, async (req, res) => {
  const {
    q: searchTerm,
    source_title,
    author,
    genre,
    type,
    year,
    year_from,
    year_to,
    tags,
    page,
    limit = 20,
    offset = 0,
  } = req.query;

  try {
    let sql = `
      SELECT
        q.*,
        u.username, u.display_name, u.avatar_url,
        s.title as source_title, s.author as source_author,
        s.year as source_year, s.genre as source_genre,
        s.type as source_type, s.cover_url as source_cover,
        EXISTS(SELECT 1 FROM likes l WHERE l.quote_id = q.id AND l.user_id = $1) as liked_by_me,
        EXISTS(SELECT 1 FROM saved_quotes sv WHERE sv.quote_id = q.id AND sv.user_id = $1) as saved_by_me
      FROM quotes q
      JOIN users u ON u.id = q.user_id
      LEFT JOIN sources s ON s.id = q.source_id
      WHERE q.is_public = true
    `;

    const params = [req.user?.id || null];

    if (searchTerm) {
      params.push(searchTerm);
      sql += ` AND q.search_vec @@ plainto_tsquery('english', $${params.length})`;
    }
    if (source_title) {
      params.push(`%${source_title.toLowerCase()}%`);
      sql += ` AND LOWER(s.title) LIKE $${params.length}`;
    }
    if (author) {
      params.push(`%${author.toLowerCase()}%`);
      sql += ` AND LOWER(s.author) LIKE $${params.length}`;
    }
    if (genre) {
      params.push(genre.toLowerCase());
      sql += ` AND LOWER(s.genre) = $${params.length}`;
    }
    if (type) {
      params.push(type.toLowerCase());
      sql += ` AND LOWER(s.type) = $${params.length}`;
    }
    if (year) {
      params.push(parseInt(year));
      sql += ` AND s.year = $${params.length}`;
    }
    if (year_from) {
      params.push(parseInt(year_from));
      sql += ` AND s.year >= $${params.length}`;
    }
    if (year_to) {
      params.push(parseInt(year_to));
      sql += ` AND s.year <= $${params.length}`;
    }
    if (tags) {
      const tagArray = tags.split(',').map(t => t.trim());
      params.push(tagArray);
      sql += ` AND q.tags && $${params.length}`;
    }
    if (page) {
      params.push(parseInt(page));
      sql += ` AND q.page_number = $${params.length}`;
    }

    if (searchTerm) {
      params.push(searchTerm);
      sql += ` ORDER BY ts_rank(q.search_vec, plainto_tsquery('english', $${params.length})) DESC`;
    } else {
      sql += ` ORDER BY q.created_at DESC`;
    }

    params.push(parseInt(limit), parseInt(offset));
    sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await query(sql, params);
    res.json({ quotes: result.rows, count: result.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/quotes/my — current user's quotes
router.get('/my', requireAuth, async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  try {
    const result = await query(
      `${quoteSelect(req.user.id)}
       WHERE q.user_id = $1
       ORDER BY q.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, parseInt(limit), parseInt(offset)]
    );
    res.json({ quotes: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/quotes/:id
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const result = await query(
      `${quoteSelect(req.user?.id)}
       WHERE q.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Quote not found' });
    const quote = result.rows[0];
    if (!quote.is_public && quote.user_id !== req.user?.id) {
      return res.status(403).json({ error: 'Private quote' });
    }
    res.json({ quote });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/quotes
router.post('/', requireAuth, [
  body('text').trim().notEmpty().isLength({ max: 5000 }),
  body('source_id').optional().isUUID(),
  body('page_number').optional().isInt({ min: 1 }),
  body('line_number').optional().isInt({ min: 1 }),
  body('chapter').optional().trim().isLength({ max: 200 }),
  body('context').optional().trim().isLength({ max: 1000 }),
  body('tags').optional().isArray(),
  body('is_public').optional().isBoolean(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });

  const { text, source_id, page_number, line_number, chapter, context, tags, is_public = true } = req.body;

  try {
    const result = await query(
      `INSERT INTO quotes (user_id, text, source_id, page_number, line_number, chapter, context, tags, is_public)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [req.user.id, text, source_id || null, page_number || null, line_number || null,
       chapter || null, context || null, tags || [], is_public]
    );

    // Fetch full quote with joins
    const full = await query(
      `${quoteSelect(req.user.id)} WHERE q.id = $1`,
      [result.rows[0].id]
    );
    res.status(201).json({ quote: full.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/quotes/:id
router.patch('/:id', requireAuth, async (req, res) => {
  const allowed = ['text', 'page_number', 'line_number', 'chapter', 'context', 'tags', 'is_public', 'source_id'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });

  try {
    const owns = await query('SELECT id FROM quotes WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!owns.rows[0]) return res.status(403).json({ error: 'Not your quote' });

    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = [req.params.id, ...Object.values(updates)];
    await query(`UPDATE quotes SET ${setClauses} WHERE id = $1`, values);

    const full = await query(`${quoteSelect(req.user.id)} WHERE q.id = $1`, [req.params.id]);
    res.json({ quote: full.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/quotes/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM quotes WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(403).json({ error: 'Not your quote or not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/quotes/:id/like
router.post('/:id/like', requireAuth, async (req, res) => {
  try {
    await query(
      'INSERT INTO likes (user_id, quote_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.user.id, req.params.id]
    );
    await query('UPDATE quotes SET likes_count = (SELECT COUNT(*) FROM likes WHERE quote_id=$1) WHERE id=$1', [req.params.id]);
    res.json({ liked: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/quotes/:id/like
router.delete('/:id/like', requireAuth, async (req, res) => {
  try {
    await query('DELETE FROM likes WHERE user_id=$1 AND quote_id=$2', [req.user.id, req.params.id]);
    await query('UPDATE quotes SET likes_count = (SELECT COUNT(*) FROM likes WHERE quote_id=$1) WHERE id=$1', [req.params.id]);
    res.json({ liked: false });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/quotes/:id/save
router.post('/:id/save', requireAuth, async (req, res) => {
  try {
    await query(
      'INSERT INTO saved_quotes (user_id, quote_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.user.id, req.params.id]
    );
    res.json({ saved: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/quotes/:id/save
router.delete('/:id/save', requireAuth, async (req, res) => {
  try {
    await query('DELETE FROM saved_quotes WHERE user_id=$1 AND quote_id=$2', [req.user.id, req.params.id]);
    res.json({ saved: false });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
