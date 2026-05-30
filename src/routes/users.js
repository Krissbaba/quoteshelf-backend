import express from 'express';
import { query } from '../db/pool.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';

const router = express.Router();

// GET /api/users/:username
router.get('/:username', optionalAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, username, display_name, bio, avatar_url, is_public, created_at,
        (SELECT COUNT(*) FROM quotes WHERE user_id=u.id AND is_public=true) as quote_count,
        (SELECT COUNT(*) FROM books WHERE user_id=u.id AND is_public=true) as book_count,
        (SELECT COUNT(*) FROM follows WHERE following_id=u.id) as followers_count,
        (SELECT COUNT(*) FROM follows WHERE follower_id=u.id) as following_count,
        EXISTS(SELECT 1 FROM follows WHERE follower_id=$2 AND following_id=u.id) as followed_by_me
       FROM users u WHERE username=$1`,
      [req.params.username, req.user?.id || null]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    const user = result.rows[0];
    if (!user.is_public && user.id !== req.user?.id) {
      return res.status(403).json({ error: 'Private profile' });
    }
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/users/:username/quotes
router.get('/:username/quotes', optionalAuth, async (req, res) => {
  const { limit = 20, offset = 0 } = req.query;
  try {
    const user = await query('SELECT id, is_public FROM users WHERE username=$1', [req.params.username]);
    if (!user.rows[0]) return res.status(404).json({ error: 'User not found' });
    const u = user.rows[0];
    if (!u.is_public && u.id !== req.user?.id) return res.status(403).json({ error: 'Private profile' });

    const result = await query(
      `SELECT q.*, s.title as source_title, s.author as source_author, s.year as source_year, s.type as source_type,
        EXISTS(SELECT 1 FROM likes l WHERE l.quote_id=q.id AND l.user_id=$3) as liked_by_me
       FROM quotes q
       LEFT JOIN sources s ON s.id = q.source_id
       WHERE q.user_id=$1 AND (q.is_public=true OR q.user_id=$3)
       ORDER BY q.created_at DESC LIMIT $2 OFFSET $4`,
      [u.id, parseInt(limit), req.user?.id || null, parseInt(offset)]
    );
    res.json({ quotes: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/users/:username/follow
router.post('/:username/follow', requireAuth, async (req, res) => {
  try {
    const target = await query('SELECT id FROM users WHERE username=$1', [req.params.username]);
    if (!target.rows[0]) return res.status(404).json({ error: 'User not found' });
    if (target.rows[0].id === req.user.id) return res.status(400).json({ error: "Can't follow yourself" });

    await query(
      'INSERT INTO follows (follower_id, following_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [req.user.id, target.rows[0].id]
    );
    res.json({ following: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/users/:username/follow
router.delete('/:username/follow', requireAuth, async (req, res) => {
  try {
    const target = await query('SELECT id FROM users WHERE username=$1', [req.params.username]);
    if (!target.rows[0]) return res.status(404).json({ error: 'User not found' });
    await query('DELETE FROM follows WHERE follower_id=$1 AND following_id=$2', [req.user.id, target.rows[0].id]);
    res.json({ following: false });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/users/:username/saved
router.get('/:username/saved', requireAuth, async (req, res) => {
  try {
    const target = await query('SELECT id FROM users WHERE username=$1', [req.params.username]);
    if (!target.rows[0] || target.rows[0].id !== req.user.id) {
      return res.status(403).json({ error: 'Can only view your own saved quotes' });
    }
    const result = await query(
      `SELECT q.*, s.title as source_title, s.author as source_author, u.username
       FROM saved_quotes sv
       JOIN quotes q ON q.id = sv.quote_id
       JOIN users u ON u.id = q.user_id
       LEFT JOIN sources s ON s.id = q.source_id
       WHERE sv.user_id=$1
       ORDER BY sv.created_at DESC`,
      [req.user.id]
    );
    res.json({ quotes: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
