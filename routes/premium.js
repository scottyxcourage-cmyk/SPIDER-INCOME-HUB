const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { protect } = require('../middleware/auth');
const { PLANS, getEffectivePlan } = require('../utils/plans');

// GET /api/premium/plans — public catalog (no auth needed to browse pricing)
router.get('/plans', async (req, res) => {
  res.json({ plans: Object.values(PLANS) });
});

// GET /api/premium/status — current user's active plan + expiry
router.get('/status', protect, async (req, res) => {
  const plan = await getEffectivePlan(req.user);
  res.json({
    plan: plan.id,
    planName: plan.name,
    expiresAt: plan.id === 'free' ? null : req.user.plan_expires_at,
    benefits: plan.benefits,
    balance: req.user.wallet_balance || 0
  });
});

// POST /api/premium/upgrade — { planId }
router.post('/upgrade', protect, async (req, res) => {
  try {
    const { planId } = req.body;
    const plan = PLANS[planId];
    if (!plan || plan.id === 'free') return res.status(400).json({ message: 'Invalid plan' });

    const balRes = await db.execute({ sql: 'SELECT wallet_balance FROM users WHERE id = ?', args: [req.user.id] });
    const balance = balRes.rows[0]?.wallet_balance || 0;
    if (balance < plan.priceCOPS) {
      return res.status(400).json({ message: `Insufficient balance. Need ⚡${plan.priceCOPS} COPS, you have ⚡${balance}.` });
    }

    // If already on a paid plan that hasn't expired, extend from the current expiry rather than today
    const current = await getEffectivePlan(req.user);
    const base = (current.id !== 'free' && req.user.plan_expires_at && new Date(req.user.plan_expires_at) > new Date())
      ? new Date(req.user.plan_expires_at)
      : new Date();
    const newExpiry = new Date(base.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);

    await db.execute({
      sql: `UPDATE users SET wallet_balance = wallet_balance - ?, plan = ?, plan_expires_at = ?,
                              is_verified_badge = ?
            WHERE id = ?`,
      args: [plan.priceCOPS, plan.id, newExpiry.toISOString(), plan.badge ? 1 : 0, req.user.id]
    });
    await db.execute({
      sql: `INSERT INTO wallet_transactions (id, user_id, type, amount, description) VALUES (?, ?, 'spend', ?, ?)`,
      args: [uuidv4(), req.user.id, -plan.priceCOPS, `Upgraded to ${plan.name} (${plan.durationDays} days)`]
    });
    await db.execute({
      sql: `INSERT INTO notifications (id, user_id, title, body, type) VALUES (?, ?, ?, ?, 'success')`,
      args: [uuidv4(), req.user.id, `👑 Welcome to ${plan.name}!`, `Your ${plan.name} membership is active until ${newExpiry.toDateString()}.`]
    });

    res.json({ message: `Upgraded to ${plan.name}!`, plan: plan.id, expiresAt: newExpiry.toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
