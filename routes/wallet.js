const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { protect } = require('../middleware/auth');
const { getEffectivePlan } = require('../utils/plans');

// GET /api/wallet/overview — balance, recent transactions, pending withdrawal
router.get('/overview', protect, async (req, res) => {
  try {
    const uid = req.user.id;
    const plan = await getEffectivePlan(req.user);
    const minWithdrawal = plan.minWithdrawal;
    const txns = await db.execute({
      sql: 'SELECT id, type, amount, description, created_at FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      args: [uid]
    });
    const pending = await db.execute({
      sql: `SELECT id, amount, method, account_details, status, created_at
            FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`,
      args: [uid]
    });
    res.json({
      balance: req.user.wallet_balance || 0,
      points: req.user.points_balance || 0,
      transactions: txns.rows,
      withdrawals: pending.rows,
      minWithdrawal
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/wallet/withdraw — request a withdrawal; funds are held (deducted) immediately
router.post('/withdraw', protect, async (req, res) => {
  try {
    const { amount, method, accountDetails } = req.body;
    const plan = await getEffectivePlan(req.user);
    const amt = parseInt(amount, 10);
    if (!amt || amt < plan.minWithdrawal) {
      return res.status(400).json({ message: `Minimum withdrawal is ⚡${plan.minWithdrawal} COPS on your plan` });
    }
    if (!method || !accountDetails || !accountDetails.trim()) {
      return res.status(400).json({ message: 'Payout method and account details are required' });
    }

    const balRes = await db.execute({ sql: 'SELECT wallet_balance FROM users WHERE id = ?', args: [req.user.id] });
    const balance = balRes.rows[0]?.wallet_balance || 0;
    if (balance < amt) return res.status(400).json({ message: 'Insufficient balance' });

    // Hold the funds immediately so they can't double-spend while pending review
    await db.execute({ sql: 'UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?', args: [amt, req.user.id] });
    await db.execute({
      sql: `INSERT INTO wallet_transactions (id, user_id, type, amount, description) VALUES (?, ?, 'withdraw', ?, 'Withdrawal request')`,
      args: [uuidv4(), req.user.id, -amt]
    });

    const id = uuidv4();
    await db.execute({
      sql: 'INSERT INTO withdrawals (id, user_id, amount, method, account_details) VALUES (?, ?, ?, ?, ?)',
      args: [id, req.user.id, amt, method, accountDetails.trim()]
    });

    res.json({ message: 'Withdrawal request submitted — pending review', id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/wallet/redeem-coupon
router.post('/redeem-coupon', protect, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || !code.trim()) return res.status(400).json({ message: 'Coupon code required' });
    const normalizedCode = code.trim().toUpperCase();

    const couponRes = await db.execute({ sql: 'SELECT * FROM coupons WHERE code = ? AND active = 1', args: [normalizedCode] });
    if (couponRes.rows.length === 0) return res.status(404).json({ message: 'Invalid or expired coupon code' });
    const coupon = couponRes.rows[0];

    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
      return res.status(400).json({ message: 'This coupon has expired' });
    }
    if (coupon.used_count >= coupon.max_uses) {
      return res.status(400).json({ message: 'This coupon has reached its usage limit' });
    }
    const already = await db.execute({
      sql: 'SELECT 1 FROM coupon_redemptions WHERE coupon_code = ? AND user_id = ?',
      args: [normalizedCode, req.user.id]
    });
    if (already.rows.length > 0) return res.status(400).json({ message: "You've already redeemed this coupon" });

    if (coupon.type === 'points') {
      await db.execute({ sql: 'UPDATE users SET points_balance = points_balance + ? WHERE id = ?', args: [coupon.value, req.user.id] });
    } else {
      await db.execute({ sql: 'UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', args: [coupon.value, req.user.id] });
      await db.execute({
        sql: `INSERT INTO wallet_transactions (id, user_id, type, amount, description) VALUES (?, ?, 'coupon', ?, ?)`,
        args: [uuidv4(), req.user.id, coupon.value, `Coupon redeemed: ${normalizedCode}`]
      });
    }
    await db.execute({ sql: 'INSERT INTO coupon_redemptions (coupon_code, user_id) VALUES (?, ?)', args: [normalizedCode, req.user.id] });
    await db.execute({ sql: 'UPDATE coupons SET used_count = used_count + 1 WHERE code = ?', args: [normalizedCode] });

    res.json({
      message: coupon.type === 'points' ? `+${coupon.value} points redeemed!` : `+⚡${coupon.value} COPS redeemed!`,
      type: coupon.type,
      value: coupon.value
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── Streak Freeze ──────────────────────────────────────────
// POST /api/wallet/streak-freeze/buy — spend COPS to protect the streak against one missed day
const STREAK_FREEZE_COST = 50;
router.post('/streak-freeze/buy', protect, async (req, res) => {
  try {
    const balance = req.user.wallet_balance || 0;
    if (balance < STREAK_FREEZE_COST) {
      return res.status(400).json({ message: `You need ⚡${STREAK_FREEZE_COST} COPS to buy a Streak Freeze` });
    }
    await db.execute({
      sql: 'UPDATE users SET wallet_balance = wallet_balance - ?, streak_freezes = streak_freezes + 1 WHERE id = ?',
      args: [STREAK_FREEZE_COST, req.user.id]
    });
    await db.execute({
      sql: `INSERT INTO wallet_transactions (id, user_id, type, amount, description) VALUES (?, ?, 'purchase', ?, 'Streak Freeze purchased')`,
      args: [uuidv4(), req.user.id, -STREAK_FREEZE_COST]
    });
    const updated = await db.execute({ sql: 'SELECT wallet_balance, streak_freezes FROM users WHERE id = ?', args: [req.user.id] });
    res.json({
      message: '🧊 Streak Freeze purchased!',
      newBalance: updated.rows[0].wallet_balance,
      streakFreezes: updated.rows[0].streak_freezes
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
