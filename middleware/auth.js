const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { db } = require('../db');

// Returns an error message string if the account is banned/suspended, otherwise null.
// Suspensions auto-expire — lazily downgraded back to 'active' here rather than needing a cron job.
function checkAccountStatus(user) {
  if (user.account_status === 'banned') return 'This account has been banned. Contact support if you believe this is a mistake.';
  if (user.account_status === 'suspended') {
    if (user.suspended_until && new Date(user.suspended_until) < new Date()) {
      db.execute({ sql: "UPDATE users SET account_status = 'active', suspended_until = NULL WHERE id = ?", args: [user.id] }).catch(()=>{});
      return null;
    }
    return `This account is suspended${user.suspended_until ? ' until ' + new Date(user.suspended_until).toLocaleString() : ''}.`;
  }
  return null;
}

const USER_FIELDS = `id, username, email, role, avatar, bio, wallet_balance, is_verified,
                   points_balance, xp, level, streak_count, last_checkin, referral_code,
                   referred_by, cover_photo, is_verified_badge, ai_daily_used, ai_daily_date,
                   plan, plan_expires_at, totp_secret, totp_enabled, notification_prefs,
                   profile_visibility, show_online_status, google_linked,
                   account_status, warning_count, suspended_until, created_at`;

const protect = async (req, res, next) => {
  try {
    // Personal API keys (Settings > API Keys) work as an alternative to the JWT session token,
    // so users can call the API from scripts/bots without logging in through the browser.
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
      const keyRow = await db.execute({ sql: 'SELECT id, user_id FROM api_keys WHERE key_hash = ? AND revoked = 0', args: [keyHash] });
      if (keyRow.rows.length === 0) return res.status(401).json({ message: 'Invalid API key' });

      const result = await db.execute({ sql: `SELECT ${USER_FIELDS} FROM users WHERE id = ?`, args: [keyRow.rows[0].user_id] });
      if (result.rows.length === 0) return res.status(401).json({ message: 'User not found' });
      const banCheck = checkAccountStatus(result.rows[0]);
      if (banCheck) return res.status(403).json({ message: banCheck });

      req.user = result.rows[0];
      db.execute({ sql: "UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?", args: [keyRow.rows[0].id] }).catch(()=>{});
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Not authorized, no token' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await db.execute({
      sql: `SELECT ${USER_FIELDS} FROM users WHERE id = ?`,
      args: [decoded.id]
    });

    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'User not found' });
    }
    const banCheck = checkAccountStatus(result.rows[0]);
    if (banCheck) return res.status(403).json({ message: banCheck });

    req.user = result.rows[0];
    // Update last_seen (fire and forget)
    db.execute({ sql: "UPDATE users SET last_seen = datetime('now') WHERE id = ?", args: [decoded.id] }).catch(()=>{});
    next();
  } catch (err) {
    res.status(401).json({ message: 'Token invalid or expired' });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ message: 'Admins only' });
  }
  next();
};

// Like `protect`, but never blocks the request — just attaches req.user if a valid
// token is present. Used for endpoints (like the downloader) that work whether or
// not you're logged in, but should still log activity for logged-in users.
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return next();
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await db.execute({ sql: 'SELECT id, username FROM users WHERE id = ?', args: [decoded.id] });
    if (result.rows.length > 0) req.user = result.rows[0];
  } catch (err) { /* invalid/expired token — just proceed unauthenticated */ }
  next();
};

module.exports = { protect, adminOnly, optionalAuth, checkAccountStatus };
