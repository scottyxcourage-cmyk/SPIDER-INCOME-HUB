const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { protect } = require('../middleware/auth');
const { createNotification } = require('./notifications');

// POST /api/follows/:id — follow or unfollow a user
router.post('/:id', protect, async (req, res) => {
  try {
    const targetId = req.params.id;
    const userId = req.user.id;
    if (targetId === userId) return res.status(400).json({ message: "You can't follow yourself" });

    const existing = await db.execute({
      sql: 'SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?',
      args: [userId, targetId]
    });

    if (existing.rows.length > 0) {
      await db.execute({
        sql: 'DELETE FROM follows WHERE follower_id = ? AND following_id = ?',
        args: [userId, targetId]
      });
      res.json({ following: false });
    } else {
      await db.execute({
        sql: 'INSERT INTO follows (follower_id, following_id) VALUES (?, ?)',
        args: [userId, targetId]
      });

      // Check if this follow makes them mutual (target already followed userId)
      const reciprocal = await db.execute({
        sql: 'SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?',
        args: [targetId, userId]
      });
      const isMutual = reciprocal.rows.length > 0;

      if (isMutual) {
        const target = await db.execute({ sql: 'SELECT username FROM users WHERE id = ?', args: [targetId] });
        const targetUsername = target.rows[0]?.username || 'this user';
        await createNotification(targetId, '🤝 New Friend', `You and ${req.user.username} are now friends!`, 'info');
        await createNotification(userId, '🤝 New Friend', `You and ${targetUsername} are now friends!`, 'info');
      } else {
        await createNotification(targetId, '👤 New Follower', `${req.user.username} started following you.`, 'info');
      }

      res.json({ following: true, isMutual });
    }
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/follows/:id/status — check if current user follows :id
router.get('/:id/status', protect, async (req, res) => {
  try {
    const r = await db.execute({
      sql: 'SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?',
      args: [req.user.id, req.params.id]
    });
    res.json({ following: r.rows.length > 0 });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/follows/following — list of users current user follows
router.get('/following/list', protect, async (req, res) => {
  try {
    const r = await db.execute({
      sql: `SELECT u.id, u.username, u.avatar, u.bio, u.last_seen,
                   EXISTS(SELECT 1 FROM follows fb WHERE fb.follower_id = u.id AND fb.following_id = ?) as is_mutual
            FROM follows f JOIN users u ON f.following_id = u.id
            WHERE f.follower_id = ? ORDER BY f.created_at DESC`,
      args: [req.user.id, req.user.id]
    });
    res.json(r.rows.map(row => ({ ...row, isMutual: !!row.is_mutual })));
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/follows/friends — mutual follows only ("friends")
router.get('/friends/list', protect, async (req, res) => {
  try {
    const r = await db.execute({
      sql: `SELECT u.id, u.username, u.avatar, u.bio, u.last_seen
            FROM follows f
            JOIN users u ON f.following_id = u.id
            WHERE f.follower_id = ?
              AND EXISTS(SELECT 1 FROM follows fb WHERE fb.follower_id = u.id AND fb.following_id = ?)
            ORDER BY f.created_at DESC`,
      args: [req.user.id, req.user.id]
    });
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/follows/feed — posts from followed users only
router.get('/feed', protect, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 15;
    const offset = (page - 1) * limit;

    const posts = await db.execute({
      sql: `SELECT p.id, p.content, p.media_url, p.pinned, p.created_at,
                   u.id as author_id, u.username as author_username, u.avatar as author_avatar, u.last_seen as author_last_seen,
                   (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
                   (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count
            FROM posts p
            JOIN users u ON p.author_id = u.id
            WHERE p.author_id IN (
              SELECT following_id FROM follows WHERE follower_id = ?
            ) OR p.author_id = ? OR p.pinned = 1
            ORDER BY p.pinned DESC, p.created_at DESC
            LIMIT ? OFFSET ?`,
      args: [req.user.id, req.user.id, limit, offset]
    });

    const postIds = posts.rows.map(p => p.id);
    let likedSet = new Set();
    if (postIds.length > 0) {
      const liked = await db.execute({
        sql: `SELECT post_id FROM likes WHERE user_id = ? AND post_id IN (${postIds.map(() => '?').join(',')})`,
        args: [req.user.id, ...postIds]
      });
      likedSet = new Set(liked.rows.map(r => r.post_id));
    }

    res.json(posts.rows.map(p => ({
      id: p.id, content: p.content, mediaUrl: p.media_url, pinned: p.pinned,
      createdAt: p.created_at,
      author: { id: p.author_id, username: p.author_username, avatar: p.author_avatar, lastSeen: p.author_last_seen },
      likeCount: p.like_count, commentCount: p.comment_count, liked: likedSet.has(p.id)
    })));
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
