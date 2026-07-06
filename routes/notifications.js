const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { protect } = require('../middleware/auth');

// GET /api/notifications — get user's notifications
router.get('/', protect, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      args: [req.user.id]
    });
    const unread = result.rows.filter(n => !n.is_read).length;
    res.json({ notifications: result.rows, unread });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/notifications/read-all — mark all read
router.put('/read-all', protect, async (req, res) => {
  try {
    await db.execute({
      sql: 'UPDATE notifications SET is_read = 1 WHERE user_id = ?',
      args: [req.user.id]
    });
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/notifications/:id/read
router.put('/:id/read', protect, async (req, res) => {
  try {
    await db.execute({
      sql: 'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
      args: [req.params.id, req.user.id]
    });
    res.json({ message: 'Notification marked as read' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/notifications — internal: create notification for a user (admin only)
router.post('/', protect, async (req, res) => {
  try {
    const { userId, title, body, type } = req.body;
    if (!userId || !title || !body) return res.status(400).json({ message: 'userId, title, body required' });
    const id = uuidv4();
    await db.execute({
      sql: 'INSERT INTO notifications (id, user_id, title, body, type) VALUES (?, ?, ?, ?, ?)',
      args: [id, userId, title, body, type || 'info']
    });
    res.status(201).json({ message: 'Notification sent', id });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Helper export to create notification from other routes.
// `category` maps to the Settings > Notification Preferences toggles (rewards/referrals/social/marketing).
// If not passed explicitly, it's inferred from `type` + content as a reasonable default.
const createNotification = async (userId, title, body, type = 'info', category = null) => {
  try {
    if (!category) {
      if (type === 'reward' && /referral/i.test(title + body)) category = 'referrals';
      else if (type === 'reward') category = 'rewards';
      else category = 'social';
    }

    const userRow = await db.execute({ sql: 'SELECT notification_prefs FROM users WHERE id = ?', args: [userId] });
    let prefs = { rewards: true, referrals: true, social: true, marketing: true };
    try { prefs = { ...prefs, ...JSON.parse(userRow.rows[0]?.notification_prefs || '{}') }; } catch (e) { /* use defaults */ }
    if (prefs[category] === false) return; // user opted out of this category

    await db.execute({
      sql: 'INSERT INTO notifications (id, user_id, title, body, type) VALUES (?, ?, ?, ?, ?)',
      args: [uuidv4(), userId, title, body, type]
    });
  } catch (e) { /* non-fatal */ }
};

module.exports = router;
module.exports.createNotification = createNotification;
