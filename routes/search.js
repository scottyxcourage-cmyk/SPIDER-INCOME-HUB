const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { protect } = require('../middleware/auth');

// GET /api/search?q=query — search users and posts
router.get('/', protect, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ users: [], posts: [] });

    const like = `%${q}%`;

    const users = await db.execute({
      sql: `SELECT u.id, u.username, u.avatar, u.bio, u.last_seen,
                   (SELECT COUNT(*) FROM follows WHERE following_id = u.id) as followers,
                   (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) as following,
                   CASE WHEN EXISTS (SELECT 1 FROM follows WHERE follower_id = ? AND following_id = u.id) THEN 1 ELSE 0 END as is_following
            FROM users u
            WHERE (u.username LIKE ? OR u.bio LIKE ?) AND u.id != ?
            LIMIT 10`,
      args: [req.user.id, like, like, req.user.id]
    });

    const posts = await db.execute({
      sql: `SELECT p.id, p.content, p.media_url, p.created_at,
                   u.id as author_id, u.username as author_username, u.avatar as author_avatar,
                   (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
                   (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count,
                   CASE WHEN EXISTS (SELECT 1 FROM likes WHERE post_id = p.id AND user_id = ?) THEN 1 ELSE 0 END as liked
            FROM posts p JOIN users u ON p.author_id = u.id
            WHERE p.content LIKE ?
            ORDER BY p.created_at DESC LIMIT 10`,
      args: [req.user.id, like]
    });

    res.json({ users: users.rows, posts: posts.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
