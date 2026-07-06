const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { protect } = require('../middleware/auth');

// GET /api/news — public news feed for logged-in users (content is managed via /api/admin/news)
router.get('/', protect, async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM news ORDER BY created_at DESC LIMIT 50');
    res.json({ news: result.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
