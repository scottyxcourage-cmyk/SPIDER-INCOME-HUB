const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { protect } = require('../middleware/auth');
const { progressMission } = require('../utils/missions');

// Spin wheel prize table (weighted). Weight = relative chance, higher = more likely.
const SPIN_PRIZES = [
  { type: 'points', value: 10,  weight: 30, label: '10 Points' },
  { type: 'points', value: 25,  weight: 25, label: '25 Points' },
  { type: 'points', value: 50,  weight: 15, label: '50 Points' },
  { type: 'points', value: 100, weight: 8,  label: '100 Points' },
  { type: 'cops',   value: 5,   weight: 12, label: '⚡5 COPS' },
  { type: 'cops',   value: 20,  weight: 5,  label: '⚡20 COPS' },
  { type: 'xp',     value: 20,  weight: 4,  label: '20 XP Boost' },
  { type: 'nothing',value: 0,   weight: 1,  label: 'Try Again' },
];

function pickPrize() {
  const total = SPIN_PRIZES.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of SPIN_PRIZES) {
    if (r < p.weight) return p;
    r -= p.weight;
  }
  return SPIN_PRIZES[0];
}

// GET /api/earn/overview — everything the Earn Center home tab needs
router.get('/overview', protect, async (req, res) => {
  try {
    const uid = req.user.id;

    const todayKey = new Date().toISOString().slice(0, 10);
    const lastSpin = await db.execute({
      sql: "SELECT created_at FROM spin_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
      args: [uid]
    });
    const canSpin = !lastSpin.rows[0] || lastSpin.rows[0].created_at.slice(0, 10) !== todayKey;

    const tasks = await db.execute({
      sql: `SELECT t.id, t.title, t.description, t.platform, t.link, t.points_reward, t.xp_reward,
                   CASE WHEN ut.user_id IS NULL THEN 0 ELSE 1 END as completed
            FROM tasks t LEFT JOIN user_tasks ut ON ut.task_id = t.id AND ut.user_id = ?
            WHERE t.active = 1 ORDER BY t.created_at ASC`,
      args: [uid]
    });

    const referralCount = await db.execute({
      sql: 'SELECT COUNT(*) as c FROM users WHERE referred_by = ?',
      args: [req.user.referral_code]
    });
    const referralEarnings = await db.execute({
      sql: "SELECT COALESCE(SUM(amount),0) as total FROM wallet_transactions WHERE user_id = ? AND type = 'referral'",
      args: [uid]
    });

    res.json({
      balance: { cops: req.user.wallet_balance || 0, points: req.user.points_balance || 0 },
      spin: { canSpin, prizes: SPIN_PRIZES.map(p => ({ type: p.type, label: p.label })) },
      tasks: tasks.rows,
      referral: {
        code: req.user.referral_code,
        totalReferrals: referralCount.rows[0].c,
        totalEarnings: referralEarnings.rows[0].total
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/earn/spin — one free spin per day
router.post('/spin', protect, async (req, res) => {
  try {
    const uid = req.user.id;
    const todayKey = new Date().toISOString().slice(0, 10);
    const lastSpin = await db.execute({
      sql: "SELECT created_at FROM spin_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
      args: [uid]
    });
    if (lastSpin.rows[0] && lastSpin.rows[0].created_at.slice(0, 10) === todayKey) {
      return res.status(400).json({ message: 'You already spun today — come back tomorrow!' });
    }

    const prize = pickPrize();

    if (prize.type === 'points') {
      await db.execute({ sql: 'UPDATE users SET points_balance = points_balance + ? WHERE id = ?', args: [prize.value, uid] });
    } else if (prize.type === 'cops') {
      await db.execute({ sql: 'UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', args: [prize.value, uid] });
      await db.execute({
        sql: `INSERT INTO wallet_transactions (id, user_id, type, amount, description) VALUES (?, ?, 'reward', ?, 'Spin wheel prize')`,
        args: [uuidv4(), uid, prize.value]
      });
    } else if (prize.type === 'xp') {
      await db.execute({ sql: 'UPDATE users SET xp = xp + ? WHERE id = ?', args: [prize.value, uid] });
    }

    await db.execute({
      sql: 'INSERT INTO spin_history (id, user_id, prize_type, prize_value) VALUES (?, ?, ?, ?)',
      args: [uuidv4(), uid, prize.type, String(prize.value)]
    });
    await progressMission(uid, 'spin', 1);

    res.json({ message: 'Spin complete!', prize });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/earn/tasks/:id/complete — claim a one-time task reward
router.post('/tasks/:id/complete', protect, async (req, res) => {
  try {
    const uid = req.user.id;
    const taskId = req.params.id;

    const task = await db.execute({ sql: 'SELECT * FROM tasks WHERE id = ? AND active = 1', args: [taskId] });
    if (task.rows.length === 0) return res.status(404).json({ message: 'Task not found' });
    const t = task.rows[0];

    const existing = await db.execute({ sql: 'SELECT 1 FROM user_tasks WHERE user_id = ? AND task_id = ?', args: [uid, taskId] });
    if (existing.rows.length > 0) return res.status(400).json({ message: 'Task already completed' });

    await db.execute({ sql: 'INSERT INTO user_tasks (user_id, task_id) VALUES (?, ?)', args: [uid, taskId] });
    await db.execute({
      sql: 'UPDATE users SET points_balance = points_balance + ?, xp = xp + ? WHERE id = ?',
      args: [t.points_reward, t.xp_reward, uid]
    });

    res.json({ message: 'Task completed!', pointsEarned: t.points_reward, xpEarned: t.xp_reward });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/earn/referrals — detailed referral list + commission history
router.get('/referrals', protect, async (req, res) => {
  try {
    const uid = req.user.id;
    const referred = await db.execute({
      sql: `SELECT id, username, avatar, created_at FROM users WHERE referred_by = ? ORDER BY created_at DESC`,
      args: [req.user.referral_code]
    });
    const commissions = await db.execute({
      sql: `SELECT id, amount, description, created_at FROM wallet_transactions
            WHERE user_id = ? AND type = 'referral' ORDER BY created_at DESC LIMIT 50`,
      args: [uid]
    });
    res.json({
      code: req.user.referral_code,
      totalReferrals: referred.rows.length,
      referredUsers: referred.rows,
      commissions: commissions.rows
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/earn/leaderboard?period=weekly|monthly|alltime
router.get('/leaderboard', protect, async (req, res) => {
  try {
    const period = req.query.period || 'alltime';
    let rows;
    if (period === 'alltime') {
      const r = await db.execute(
        `SELECT id, username, avatar, points_balance, level FROM users ORDER BY points_balance DESC LIMIT 20`
      );
      rows = r.rows;
    } else {
      const days = period === 'weekly' ? 7 : 30;
      const r = await db.execute({
        sql: `SELECT u.id, u.username, u.avatar, u.level,
                     COALESCE(SUM(wt.amount), 0) as period_earnings
              FROM users u
              LEFT JOIN wallet_transactions wt ON wt.user_id = u.id
                AND wt.created_at >= datetime('now', '-' || ? || ' days')
              GROUP BY u.id
              ORDER BY period_earnings DESC
              LIMIT 20`,
        args: [days]
      });
      rows = r.rows;
    }
    res.json({ period, leaderboard: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
