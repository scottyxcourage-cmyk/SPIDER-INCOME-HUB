const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { protect } = require('../middleware/auth');
const { generateSecret, verifyTOTP, otpAuthURL } = require('../utils/totp');

// GET /api/settings — everything the Settings page needs
router.get('/', protect, async (req, res) => {
  let prefs = { rewards: true, referrals: true, social: true, marketing: true };
  try { prefs = JSON.parse(req.user.notification_prefs || '{}'); } catch (e) { /* use defaults */ }

  const keys = await db.execute({
    sql: 'SELECT id, key_preview, name, last_used_at, created_at FROM api_keys WHERE user_id = ? AND revoked = 0 ORDER BY created_at DESC',
    args: [req.user.id]
  });

  res.json({
    notificationPrefs: { rewards: true, referrals: true, social: true, marketing: true, ...prefs },
    privacy: {
      profileVisibility: req.user.profile_visibility || 'public',
      showOnlineStatus: !!req.user.show_online_status
    },
    security: {
      totpEnabled: !!req.user.totp_enabled,
      googleLinked: !!req.user.google_linked
    },
    apiKeys: keys.rows
  });
});

// PUT /api/settings/notifications
router.put('/notifications', protect, async (req, res) => {
  try {
    const { rewards, referrals, social, marketing } = req.body;
    const prefs = { rewards: !!rewards, referrals: !!referrals, social: !!social, marketing: !!marketing };
    await db.execute({ sql: 'UPDATE users SET notification_prefs = ? WHERE id = ?', args: [JSON.stringify(prefs), req.user.id] });
    res.json({ message: 'Notification preferences updated', prefs });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/settings/privacy
router.put('/privacy', protect, async (req, res) => {
  try {
    const { profileVisibility, showOnlineStatus } = req.body;
    if (profileVisibility && !['public', 'private'].includes(profileVisibility)) {
      return res.status(400).json({ message: 'Invalid visibility value' });
    }
    await db.execute({
      sql: 'UPDATE users SET profile_visibility = COALESCE(?, profile_visibility), show_online_status = ? WHERE id = ?',
      args: [profileVisibility || null, showOnlineStatus ? 1 : 0, req.user.id]
    });
    res.json({ message: 'Privacy settings updated' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── 2FA (TOTP) ──────────────────────────────────
// POST /api/settings/2fa/setup — generates a secret + QR-ready otpauth URL (not yet enabled)
router.post('/2fa/setup', protect, async (req, res) => {
  try {
    const secret = generateSecret();
    await db.execute({ sql: 'UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?', args: [secret, req.user.id] });
    res.json({ secret, otpAuthUrl: otpAuthURL(secret, req.user.username) });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/settings/2fa/verify — { token } confirms setup and turns 2FA on
router.post('/2fa/verify', protect, async (req, res) => {
  try {
    const { token } = req.body;
    const row = await db.execute({ sql: 'SELECT totp_secret FROM users WHERE id = ?', args: [req.user.id] });
    const secret = row.rows[0]?.totp_secret;
    if (!secret) return res.status(400).json({ message: 'Run 2FA setup first' });
    if (!verifyTOTP(secret, token)) return res.status(400).json({ message: 'Invalid code — check your authenticator app and try again' });

    await db.execute({ sql: 'UPDATE users SET totp_enabled = 1 WHERE id = ?', args: [req.user.id] });
    res.json({ message: '2FA enabled!' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/settings/2fa/disable — { token } requires a valid code to turn off
router.post('/2fa/disable', protect, async (req, res) => {
  try {
    const { token } = req.body;
    const row = await db.execute({ sql: 'SELECT totp_secret FROM users WHERE id = ?', args: [req.user.id] });
    const secret = row.rows[0]?.totp_secret;
    if (!secret || !verifyTOTP(secret, token)) return res.status(400).json({ message: 'Invalid code' });

    await db.execute({ sql: 'UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', args: [req.user.id] });
    res.json({ message: '2FA disabled' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── API KEYS ────────────────────────────────────
// POST /api/settings/api-keys — { name } generates a new key (shown once, in full)
router.post('/api-keys', protect, async (req, res) => {
  try {
    const rawKey = 'sh_' + crypto.randomBytes(24).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const preview = rawKey.slice(0, 10) + '…' + rawKey.slice(-4);

    const id = uuidv4();
    await db.execute({
      sql: 'INSERT INTO api_keys (id, user_id, key_hash, key_preview, name) VALUES (?, ?, ?, ?, ?)',
      args: [id, req.user.id, keyHash, preview, req.body.name || 'API Key']
    });

    res.status(201).json({ id, key: rawKey, message: 'Save this key now — it will not be shown again' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/settings/api-keys/:id
router.delete('/api-keys/:id', protect, async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE api_keys SET revoked = 1 WHERE id = ? AND user_id = ?', args: [req.params.id, req.user.id] });
    res.json({ message: 'API key revoked' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
