const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { sendOTP, sendVerification } = require('../utils/email');
// Verify via Google's tokeninfo endpoint instead of fetching JWKS certs
// ourselves. This lives on oauth2.googleapis.com (not www.googleapis.com,
// where /oauth2/v1/certs and /oauth2/v3/certs both get blocked with an
// anti-bot 403 from Render's egress IPs) and does the signature check on
// Google's side, so we never need to reach the blocked domain at all.
async function verifyGoogleIdToken(idToken) {
  const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`, {
    headers: { 'Accept': 'application/json' }
  });

  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    console.error(`tokeninfo fetch failed: status=${resp.status}, body(first 300)=${bodyText.slice(0, 300)}`);
    throw new Error(`Google tokeninfo returned ${resp.status}`);
  }

  const payload = await resp.json();

  if (payload.aud !== process.env.GOOGLE_CLIENT_ID) {
    throw new Error('Token audience mismatch');
  }
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
    throw new Error('Token issuer mismatch');
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Number(payload.exp) < nowSeconds) {
    throw new Error('Token expired');
  }

  return payload; // contains email, name, picture, email_verified, etc.
}

const ADMIN_EMAIL = 'tadiwamakumani2004zw.com@gmail.com';

const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();
const generateToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '7d' });
const generateReferralCode = (username) =>
  'SP-' + (username || 'USER').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) + Math.floor(Math.random() * 900 + 100);
const { progressMission } = require('../utils/missions');

const REFERRAL_SIGNUP_BONUS_POINTS = 100;
const REFERRAL_SIGNUP_BONUS_XP = 25;
const REFERRAL_SIGNUP_BONUS_COPS = 10; // ≈ $0.12 at the app's 50 COPS = $0.60 rate

const awardBadge = async (userId, badgeId) => {
  await db.execute({
    sql: 'INSERT OR IGNORE INTO user_badges (user_id, badge_id) VALUES (?, ?)',
    args: [userId, badgeId]
  }).catch(() => {});
};

// Credits the referrer once a new user verifies their account
const rewardReferrer = async (referredByCode, newUserId) => {
  if (!referredByCode) return;
  const referrer = await db.execute({ sql: 'SELECT id FROM users WHERE referral_code = ?', args: [referredByCode] });
  if (referrer.rows.length === 0) return;
  const referrerId = referrer.rows[0].id;
  if (referrerId === newUserId) return;

  await db.execute({
    sql: `UPDATE users SET points_balance = points_balance + ?, xp = xp + ?, wallet_balance = wallet_balance + ? WHERE id = ?`,
    args: [REFERRAL_SIGNUP_BONUS_POINTS, REFERRAL_SIGNUP_BONUS_XP, REFERRAL_SIGNUP_BONUS_COPS, referrerId]
  });
  await db.execute({
    sql: `INSERT INTO wallet_transactions (id, user_id, type, amount, description) VALUES (?, ?, 'referral', ?, 'New referral signup bonus')`,
    args: [uuidv4(), referrerId, REFERRAL_SIGNUP_BONUS_COPS]
  });
  await db.execute({
    sql: `INSERT INTO notifications (id, user_id, title, body, type) VALUES (?, ?, 'New Referral! 🎉', ?, 'reward')`,
    args: [uuidv4(), referrerId, `You earned ⚡${REFERRAL_SIGNUP_BONUS_COPS} COPS + ${REFERRAL_SIGNUP_BONUS_POINTS} points for referring a new user!`]
  });

  const referralCount = await db.execute({ sql: 'SELECT COUNT(*) as c FROM users WHERE referred_by = ?', args: [referredByCode] });
  if (referralCount.rows[0].c >= 5) await awardBadge(referrerId, 'badge_referrer');
  await progressMission(referrerId, 'referral', 1);
};

// Auto-promote admin email helper
const ensureAdmin = async (email, userId) => {
  if (email.toLowerCase() === ADMIN_EMAIL) {
    await db.execute({ sql: "UPDATE users SET role='admin' WHERE id=?", args: [userId] });
  }
};

// POST /api/auth/google
router.post('/google', async (req, res) => {
  try {
    const { credential, referralCode } = req.body;
    if (!credential) return res.status(400).json({ message: 'Google credential required' });

    const payload = await verifyGoogleIdToken(credential);
    const { email, name, picture } = payload;

    if (!email) return res.status(400).json({ message: 'Google account has no email' });

    const existing = await db.execute({
      sql: 'SELECT * FROM users WHERE email = ?',
      args: [email.toLowerCase()]
    });

    if (existing.rows.length > 0) {
      const user = existing.rows[0];
      await ensureAdmin(email, user.id);
      if (!user.google_linked) {
        await db.execute({ sql: 'UPDATE users SET google_linked = 1 WHERE id = ?', args: [user.id] });
      }
      const updated = await db.execute({ sql: 'SELECT * FROM users WHERE id=?', args: [user.id] });
      const u = updated.rows[0];
      const token = generateToken(u.id);
      return res.json({
        token,
        user: { id: u.id, username: u.username, email: u.email, role: u.role, avatar: u.avatar }
      });
    }

    const id = uuidv4();
    let baseUsername = (name || email.split('@')[0]).replace(/[^a-zA-Z0-9_]/g, '').substring(0, 18) || 'user';
    const suffix = Math.floor(1000 + Math.random() * 9000);
    const username = `${baseUsername}${suffix}`;
    const placeholderHash = await bcrypt.hash(uuidv4(), 10);
    const myReferralCode = generateReferralCode(username);

    let referredBy = null;
    if (referralCode) {
      const refUser = await db.execute({ sql: 'SELECT id FROM users WHERE referral_code = ?', args: [referralCode.toUpperCase()] });
      if (refUser.rows.length > 0) referredBy = referralCode.toUpperCase();
    }

    await db.execute({
      sql: `INSERT INTO users (id, username, email, password, avatar, is_verified, referral_code, referred_by, google_linked) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1)`,
      args: [id, username, email.toLowerCase(), placeholderHash, picture || '', myReferralCode, referredBy]
    });

    if (referredBy) await rewardReferrer(referredBy, id);
    await awardBadge(id, 'badge_welcome');
    await awardBadge(id, 'badge_verified');
    await ensureAdmin(email, id);
    const updated = await db.execute({ sql: 'SELECT * FROM users WHERE id=?', args: [id] });
    const u = updated.rows[0];
    const token = generateToken(id);
    return res.status(201).json({
      token,
      user: { id: u.id, username: u.username, email: u.email, role: u.role, avatar: u.avatar }
    });

  } catch (err) {
    console.error('Google auth error:', err.message, err.stack);
    const debugMsg = process.env.NODE_ENV !== 'production' ? ` (${err.message})` : '';
    res.status(401).json({ message: `Google sign-in failed. Invalid or expired token.${debugMsg}` });
  }
});

const validateEmail = async (email) => {
  try {
    const res = await fetch(`https://rapid-email-verifier.fly.dev/verify?email=${encodeURIComponent(email)}`);
    if (!res.ok) return true;
    const data = await res.json();
    if (data.disposable === true) return false;
    if (data.valid === false) return false;
    return true;
  } catch {
    return true;
  }
};

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, referralCode } = req.body;
    if (!username || !email || !password)
      return res.status(400).json({ message: 'All fields are required' });

    const emailOk = await validateEmail(email);
    if (!emailOk)
      return res.status(400).json({ message: 'Please use a valid, non-disposable email address.' });

    const exists = await db.execute({
      sql: 'SELECT id FROM users WHERE email = ? OR username = ?',
      args: [email.toLowerCase(), username]
    });
    if (exists.rows.length > 0)
      return res.status(400).json({ message: 'Email or username already taken' });

    // Validate referral code if provided
    let referredBy = null;
    if (referralCode) {
      const refUser = await db.execute({ sql: 'SELECT id FROM users WHERE referral_code = ?', args: [referralCode.toUpperCase()] });
      if (refUser.rows.length > 0) referredBy = referralCode.toUpperCase();
    }

    const id = uuidv4();
    const hashedPassword = await bcrypt.hash(password, 10);
    const otp = generateOTP();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const myReferralCode = generateReferralCode(username);

    await db.execute({
      sql: `INSERT INTO users (id, username, email, password, otp_code, otp_expires, referral_code, referred_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, username, email.toLowerCase(), hashedPassword, otp, otpExpires, myReferralCode, referredBy]
    });

    await sendVerification(email, username, otp);
    res.status(201).json({ message: 'Registered! Check your email for the verification code.', userId: id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/auth/verify
router.post('/verify', async (req, res) => {
  try {
    const { userId, otp } = req.body;
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [userId] });

    if (result.rows.length === 0) return res.status(404).json({ message: 'User not found' });
    const user = result.rows[0];

    if (user.is_verified) return res.status(400).json({ message: 'Already verified' });
    if (!user.otp_code || user.otp_code !== otp || new Date() > new Date(user.otp_expires))
      return res.status(400).json({ message: 'Invalid or expired OTP' });

    await db.execute({
      sql: 'UPDATE users SET is_verified = 1, otp_code = NULL, otp_expires = NULL WHERE id = ?',
      args: [userId]
    });

    await rewardReferrer(user.referred_by, userId);
    await awardBadge(userId, 'badge_welcome');
    await awardBadge(userId, 'badge_verified');
    await ensureAdmin(user.email, userId);
    const updated = await db.execute({ sql: 'SELECT * FROM users WHERE id=?', args: [userId] });
    const u = updated.rows[0];
    const token = generateToken(userId);
    res.json({
      message: 'Account verified!',
      token,
      user: { id: u.id, username: u.username, email: u.email, role: u.role }
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password, totpToken } = req.body;
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email.toLowerCase()] });

    if (result.rows.length === 0)
      return res.status(401).json({ message: 'Invalid email or password' });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: 'Invalid email or password' });

    if (!user.is_verified)
      return res.status(403).json({ message: 'Please verify your email first' });

    const { checkAccountStatus } = require('../middleware/auth');
    const statusMsg = checkAccountStatus(user);
    if (statusMsg) return res.status(403).json({ message: statusMsg });

    if (user.totp_enabled) {
      const { verifyTOTP } = require('../utils/totp');
      if (!totpToken) return res.status(200).json({ requiresTotp: true, message: 'Enter your 2FA code' });
      if (!verifyTOTP(user.totp_secret, totpToken)) {
        return res.status(401).json({ requiresTotp: true, message: 'Invalid 2FA code' });
      }
    }

    await ensureAdmin(email, user.id);
    const updated = await db.execute({ sql: 'SELECT * FROM users WHERE id=?', args: [user.id] });
    const u = updated.rows[0];
    const token = generateToken(u.id);
    res.json({
      token,
      user: { id: u.id, username: u.username, email: u.email, role: u.role, avatar: u.avatar }
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/auth/send-otp
router.post('/send-otp', async (req, res) => {
  try {
    const { email } = req.body;
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email.toLowerCase()] });

    if (result.rows.length === 0)
      return res.status(404).json({ message: 'No account with that email' });

    const user = result.rows[0];
    const otp = generateOTP();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await db.execute({
      sql: 'UPDATE users SET otp_code = ?, otp_expires = ? WHERE id = ?',
      args: [otp, otpExpires, user.id]
    });

    await sendOTP(email, user.username, otp);
    res.json({ message: 'OTP sent!', userId: user.id });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { userId, otp, newPassword } = req.body;
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [userId] });

    if (result.rows.length === 0) return res.status(404).json({ message: 'User not found' });
    const user = result.rows[0];

    if (!user.otp_code || user.otp_code !== otp || new Date() > new Date(user.otp_expires))
      return res.status(400).json({ message: 'Invalid or expired OTP' });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.execute({
      sql: 'UPDATE users SET password = ?, otp_code = NULL, otp_expires = NULL WHERE id = ?',
      args: [hashedPassword, userId]
    });

    res.json({ message: 'Password reset successful!' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/auth/me — verify token & return current user
const { protect } = require('../middleware/auth');
router.get('/me', protect, (req, res) => {
  res.json(req.user);
});

module.exports = router;
