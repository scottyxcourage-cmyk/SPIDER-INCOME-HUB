const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { protect, adminOnly } = require('../middleware/auth');

const VALID_CATEGORIES = ['general', 'bug', 'feature', 'other'];
const MAX_MESSAGE_LENGTH = 2000;

// POST /api/feedback — submit feedback or a bug report
router.post('/', protect, async (req, res) => {
  try {
    let { message, category } = req.body;
    message = (message || '').trim();
    if (!message) return res.status(400).json({ message: 'Feedback message is required' });
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ message: `Feedback must be under ${MAX_MESSAGE_LENGTH} characters` });
    }
    if (!VALID_CATEGORIES.includes(category)) category = 'general';

    const id = uuidv4();
    await db.execute({
      sql: 'INSERT INTO feedback (id, user_id, category, message) VALUES (?, ?, ?, ?)',
      args: [id, req.user.id, category, message]
    });
    res.json({ message: 'Thanks — your feedback has been submitted!', id });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/feedback/mine — a user's own past submissions
router.get('/mine', protect, async (req, res) => {
  try {
    const r = await db.execute({
      sql: 'SELECT id, category, message, status, created_at FROM feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      args: [req.user.id]
    });
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/feedback — admin: list all feedback (newest first)
router.get('/', protect, adminOnly, async (req, res) => {
  try {
    const r = await db.execute({
      sql: `SELECT f.id, f.category, f.message, f.status, f.created_at, u.username, u.avatar
            FROM feedback f JOIN users u ON f.user_id = u.id
            ORDER BY f.created_at DESC LIMIT 200`
    });
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/feedback/:id/status — admin: mark reviewed/resolved
router.put('/:id/status', protect, adminOnly, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['new', 'reviewed', 'resolved'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    await db.execute({ sql: 'UPDATE feedback SET status = ? WHERE id = ?', args: [status, req.params.id] });
    res.json({ message: 'Updated' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
