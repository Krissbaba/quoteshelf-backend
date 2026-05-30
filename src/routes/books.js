import express from 'express';
import { body, validationResult } from 'express-validator';
import { query } from '../db/pool.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';

const router = express.Router();

// GET /api/books — public books
router.get('/', optionalAuth, async (req, res) => {
  const { limit = 20, offset = 0, user_id } = req.query;
  try {
    let sql = `
      SELECT b.*, u.username, u.display_name, u.avatar_url,
        COUNT(bq.quote_id) as quote_count
      FROM books b
      JOIN users u ON u.id = b.user_id
      LEFT JOIN book_quotes bq ON bq.book_id = b.id
      WHERE b.is_public = true
    `;
    const params = [];
    if (user_id) {
      params.push(user_id);
      sql += ` AND b.user_id = $${params.length}`;
    }
    sql += ` GROUP BY b.id, u.username, u.display_name, u.avatar_url ORDER BY b.updated_at DESC`;
    params.push(parseInt(limit), parseInt(offset));
    sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await query(sql, params);
    res.json({ books: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/books/my
router.get('/my', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT b.*, COUNT(bq.quote_id) as quote_count
       FROM books b
       LEFT JOIN book_quotes bq ON bq.book_id = b.id
       WHERE b.user_id = $1
       GROUP BY b.id
       ORDER BY b.updated_at DESC`,
      [req.user.id]
    );
    res.json({ books: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/books/:id
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const book = await query(
      `SELECT b.*, u.username, u.display_name, u.avatar_url,
        COUNT(bq.quote_id) as quote_count
       FROM books b
       JOIN users u ON u.id = b.user_id
       LEFT JOIN book_quotes bq ON bq.book_id = b.id
       WHERE b.id = $1
       GROUP BY b.id, u.username, u.display_name, u.avatar_url`,
      [req.params.id]
    );
    if (!book.rows[0]) return res.status(404).json({ error: 'Book not found' });
    if (!book.rows[0].is_public && book.rows[0].user_id !== req.user?.id) {
      return res.status(403).json({ error: 'Private book' });
    }
    res.json({ book: book.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/books/:id/quotes
router.get('/:id/quotes', optionalAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT q.*, u.username, u.display_name,
        s.title as source_title, s.author as source_author,
        s.year as source_year, s.type as source_type,
        bq.position
       FROM book_quotes bq
       JOIN quotes q ON q.id = bq.quote_id
       JOIN users u ON u.id = q.user_id
       LEFT JOIN sources s ON s.id = q.source_id
       WHERE bq.book_id = $1
       ORDER BY bq.position ASC, bq.added_at ASC`,
      [req.params.id]
    );
    res.json({ quotes: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/books
router.post('/', requireAuth, [
  body('title').trim().notEmpty().isLength({ max: 300 }),
  body('description').optional().trim().isLength({ max: 1000 }),
  body('cover_color').optional().matches(/^#[0-9A-Fa-f]{6}$/),
  body('is_public').optional().isBoolean(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });

  const { title, description, cover_color, is_public = true } = req.body;
  try {
    const result = await query(
      `INSERT INTO books (user_id, title, description, cover_color, is_public)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.id, title, description, cover_color || '#F5F0EB', is_public]
    );
    res.status(201).json({ book: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/books/:id/quotes — add quote to book
router.post('/:id/quotes', requireAuth, async (req, res) => {
  const { quote_id, position } = req.body;
  if (!quote_id) return res.status(400).json({ error: 'quote_id required' });

  try {
    const owns = await query('SELECT id FROM books WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!owns.rows[0]) return res.status(403).json({ error: 'Not your book' });

    const maxPos = await query('SELECT COALESCE(MAX(position),0) as m FROM book_quotes WHERE book_id=$1', [req.params.id]);
    const pos = position ?? maxPos.rows[0].m + 1;

    await query(
      'INSERT INTO book_quotes (book_id, quote_id, position) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [req.params.id, quote_id, pos]
    );
    await query('UPDATE books SET updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/books/:id/quotes/:quoteId
router.delete('/:id/quotes/:quoteId', requireAuth, async (req, res) => {
  try {
    const owns = await query('SELECT id FROM books WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!owns.rows[0]) return res.status(403).json({ error: 'Not your book' });

    await query('DELETE FROM book_quotes WHERE book_id=$1 AND quote_id=$2', [req.params.id, req.params.quoteId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/books/:id/clone
router.post('/:id/clone', requireAuth, async (req, res) => {
  try {
    const original = await query('SELECT * FROM books WHERE id=$1 AND is_public=true', [req.params.id]);
    if (!original.rows[0]) return res.status(404).json({ error: 'Book not found or not public' });

    const b = original.rows[0];
    const newBook = await query(
      `INSERT INTO books (user_id, title, description, cover_color)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.id, `${b.title} (copy)`, b.description, b.cover_color]
    );

    await query(
      `INSERT INTO book_quotes (book_id, quote_id, position)
       SELECT $1, quote_id, position FROM book_quotes WHERE book_id=$2`,
      [newBook.rows[0].id, req.params.id]
    );
    await query('UPDATE books SET clones_count = clones_count+1 WHERE id=$1', [req.params.id]);

    res.status(201).json({ book: newBook.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/books/:id
router.patch('/:id', requireAuth, async (req, res) => {
  const { title, description, cover_color, is_public } = req.body;
  try {
    const result = await query(
      `UPDATE books SET
        title = COALESCE($2, title),
        description = COALESCE($3, description),
        cover_color = COALESCE($4, cover_color),
        is_public = COALESCE($5, is_public)
       WHERE id=$1 AND user_id=$6 RETURNING *`,
      [req.params.id, title, description, cover_color, is_public, req.user.id]
    );
    if (!result.rows[0]) return res.status(403).json({ error: 'Not your book' });
    res.json({ book: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/books/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const result = await query('DELETE FROM books WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.id, req.user.id]);
    if (!result.rows[0]) return res.status(403).json({ error: 'Not your book' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
