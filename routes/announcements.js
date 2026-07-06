const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { protect } = require('../middleware/auth');

// GET /api/announcements — pinned posts, used by admin's "Announce" action (routes/admin.js POST /announce)
router.get('/', protect, async (req, res) => {
  try {
    const result = await db.execute(
      `SELECT p.id, p.content, p.media_url, p.pinned, p.created_at, u.username AS author_username
       FROM posts p JOIN users u ON u.id = p.author_id
       WHERE p.pinned = 1
       ORDER BY p.created_at DESC
       LIMIT 50`
    );
    res.json({ announcements: result.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
