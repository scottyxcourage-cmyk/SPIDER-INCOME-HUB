const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { protect } = require('../middleware/auth');

// GET /api/analytics/overview — everything the Analytics page needs in one call
router.get('/overview', protect, async (req, res) => {
  try {
    const uid = req.user.id;

    // Daily earnings for the last 14 days (positive wallet_transactions only)
    const dailyEarnings = await db.execute({
      sql: `SELECT date(created_at) as day, SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as earned
            FROM wallet_transactions
            WHERE user_id = ? AND created_at >= datetime('now', '-14 days')
            GROUP BY date(created_at) ORDER BY day ASC`,
      args: [uid]
    });

    // Referral growth: new referrals per week for the last 8 weeks
    const referralGrowth = await db.execute({
      sql: `SELECT strftime('%Y-W%W', created_at) as week, COUNT(*) as count
            FROM users WHERE referred_by = ? AND created_at >= datetime('now', '-56 days')
            GROUP BY week ORDER BY week ASC`,
      args: [req.user.referral_code]
    });

    // AI usage by tool (all-time)
    const aiUsage = await db.execute({
      sql: `SELECT tool, COUNT(*) as count FROM ai_generations WHERE user_id = ? GROUP BY tool ORDER BY count DESC`,
      args: [uid]
    });
    const aiTotal = aiUsage.rows.reduce((s, r) => s + r.count, 0);

    // Download history (last 20)
    const downloads = await db.execute({
      sql: `SELECT query, source, created_at FROM download_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
      args: [uid]
    });
    const downloadTotal = await db.execute({ sql: 'SELECT COUNT(*) as c FROM download_log WHERE user_id = ?', args: [uid] });

    // Achievement progress: badges earned vs total
    const badgeProgress = await db.execute({ sql: 'SELECT COUNT(*) as c FROM badges' });
    const badgesEarned = await db.execute({ sql: 'SELECT COUNT(*) as c FROM user_badges WHERE user_id = ?', args: [uid] });

    // Totals
    const totalEarned = await db.execute({
      sql: `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END),0) as total FROM wallet_transactions WHERE user_id = ?`,
      args: [uid]
    });
    const totalSpent = await db.execute({
      sql: `SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END),0) as total FROM wallet_transactions WHERE user_id = ?`,
      args: [uid]
    });

    res.json({
      dailyEarnings: dailyEarnings.rows,
      referralGrowth: referralGrowth.rows,
      aiUsage: aiUsage.rows,
      aiTotal,
      downloads: downloads.rows,
      downloadTotal: downloadTotal.rows[0].c,
      badges: { earned: badgesEarned.rows[0].c, total: badgeProgress.rows[0].c },
      totals: { earned: totalEarned.rows[0].total, spent: totalSpent.rows[0].total },
      xp: req.user.xp || 0,
      level: req.user.level || 1,
      streak: req.user.streak_count || 0
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
