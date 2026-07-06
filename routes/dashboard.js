const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { protect } = require('../middleware/auth');
const { progressMission } = require('../utils/missions');

// XP required to reach a given level (simple curve: 100 * level^1.4)
function xpForLevel(level) {
  return Math.round(100 * Math.pow(level, 1.4));
}
function levelFromXp(xp) {
  let level = 1;
  while (xp >= xpForLevel(level + 1)) level++;
  return level;
}

// GET /api/dashboard — everything the home screen needs in one call
router.get('/', protect, async (req, res) => {
  try {
    const uid = req.user.id;

    // Referral stats
    const referralCount = await db.execute({
      sql: 'SELECT COUNT(*) as c FROM users WHERE referred_by = ?',
      args: [req.user.referral_code]
    });
    const referralEarnings = await db.execute({
      sql: "SELECT COALESCE(SUM(amount),0) as total FROM wallet_transactions WHERE user_id = ? AND type = 'referral'",
      args: [uid]
    });

    // Notifications (unread count + latest 5)
    const unreadCount = await db.execute({
      sql: 'SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0',
      args: [uid]
    });
    const latestNotifs = await db.execute({
      sql: 'SELECT id, title, body, type, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 5',
      args: [uid]
    });

    // Level/XP progress
    const level = req.user.level || levelFromXp(req.user.xp || 0);
    const currentLevelXp = xpForLevel(level);
    const nextLevelXp = xpForLevel(level + 1);
    const xp = req.user.xp || 0;

    // Recent activity: merge wallet transactions + posts (simple union feed)
    const recentTxns = await db.execute({
      sql: 'SELECT id, type, amount, description, created_at FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
      args: [uid]
    });
    const recentPosts = await db.execute({
      sql: 'SELECT id, content, created_at FROM posts WHERE author_id = ? ORDER BY created_at DESC LIMIT 5',
      args: [uid]
    });

    const activity = [
      ...recentTxns.rows.map(t => ({
        kind: 'transaction', id: t.id, label: t.description || t.type,
        amount: t.amount, type: t.type, created_at: t.created_at
      })),
      ...recentPosts.rows.map(p => ({
        kind: 'post', id: p.id, label: p.content.slice(0, 80),
        created_at: p.created_at
      }))
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 10);

    // Today's missions with progress (each mission type uses its own period — daily uses
    // the date, weekly uses the ISO week — so we resolve per-mission rather than one shared key)
    const { periodKeyFor } = require('../utils/missions');
    const allMissions = await db.execute({ sql: 'SELECT * FROM missions WHERE active = 1', args: [] });
    const missionRows = [];
    for (const m of allMissions.rows) {
      const periodKey = periodKeyFor(m.type);
      const um = await db.execute({
        sql: 'SELECT progress, completed, claimed FROM user_missions WHERE user_id = ? AND mission_id = ? AND period_key = ?',
        args: [uid, m.id, periodKey]
      });
      missionRows.push({
        ...m,
        progress: um.rows[0]?.progress || 0,
        completed: um.rows[0]?.completed || 0,
        claimed: um.rows[0]?.claimed || 0
      });
    }

    res.json({
      balance: {
        cops: req.user.wallet_balance || 0,
        points: req.user.points_balance || 0
      },
      referral: {
        code: req.user.referral_code,
        totalReferrals: referralCount.rows[0].c,
        totalEarnings: referralEarnings.rows[0].total
      },
      notifications: {
        unreadCount: unreadCount.rows[0].c,
        latest: latestNotifs.rows
      },
      streak: {
        count: req.user.streak_count || 0,
        lastCheckin: req.user.last_checkin,
        freezes: req.user.streak_freezes || 0
      },
      progress: {
        level, xp,
        currentLevelXp, nextLevelXp,
        percent: Math.min(100, Math.round(((xp - currentLevelXp) / (nextLevelXp - currentLevelXp)) * 100))
      },
      activity,
      missions: missionRows,
      user: {
        id: req.user.id,
        username: req.user.username,
        avatar: req.user.avatar,
        isVerifiedBadge: !!req.user.is_verified_badge
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error loading dashboard' });
  }
});

// POST /api/dashboard/checkin — daily login streak + reward
router.post('/checkin', protect, async (req, res) => {
  try {
    const uid = req.user.id;
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const last = req.user.last_checkin ? req.user.last_checkin.slice(0, 10) : null;

    if (last === todayStr) {
      return res.status(400).json({ message: 'Already checked in today', streak: req.user.streak_count || 0 });
    }

    let newStreak = 1;
    let usedFreeze = false;
    if (last) {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().slice(0, 10);
      if (last === yesterdayStr) {
        newStreak = (req.user.streak_count || 0) + 1;
      } else {
        // Missed exactly one day? A freeze can cover that single gap and keep the streak alive.
        const twoDaysAgo = new Date(today);
        twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
        const twoDaysAgoStr = twoDaysAgo.toISOString().slice(0, 10);
        if (last === twoDaysAgoStr && (req.user.streak_freezes || 0) > 0) {
          newStreak = (req.user.streak_count || 0) + 1;
          usedFreeze = true;
        } else {
          newStreak = 1;
        }
      }
    }

    const pointsReward = 10 + Math.min(newStreak, 30) * 2; // ramps up with streak
    const xpReward = 10;

    await db.execute({
      sql: `UPDATE users SET streak_count = ?, last_checkin = datetime('now'),
                              points_balance = points_balance + ?, xp = xp + ?,
                              streak_freezes = MAX(0, streak_freezes - ?)
            WHERE id = ?`,
      args: [newStreak, pointsReward, xpReward, usedFreeze ? 1 : 0, uid]
    });

    // Recalculate level from new XP
    const updated = await db.execute({ sql: 'SELECT xp FROM users WHERE id = ?', args: [uid] });
    const newLevel = levelFromXp(updated.rows[0].xp);
    await db.execute({ sql: 'UPDATE users SET level = ? WHERE id = ?', args: [newLevel, uid] });

    // Auto-award streak/level badges (INSERT OR IGNORE avoids dupes)
    const awardBadge = async (badgeId) => {
      await db.execute({
        sql: 'INSERT OR IGNORE INTO user_badges (user_id, badge_id) VALUES (?, ?)',
        args: [uid, badgeId]
      }).catch(() => {});
    };
    if (newStreak >= 7) await awardBadge('badge_streak7');
    if (newStreak >= 30) await awardBadge('badge_streak30');
    if (newLevel >= 10) await awardBadge('badge_level10');

    await progressMission(uid, 'login', 1);

    const freezesLeft = Math.max(0, (req.user.streak_freezes || 0) - (usedFreeze ? 1 : 0));

    await db.execute({
      sql: 'INSERT INTO notifications (id, user_id, title, body, type) VALUES (?, ?, ?, ?, ?)',
      args: [
        'notif_' + Math.random().toString(36).slice(2, 10), uid,
        'Daily Check-in',
        usedFreeze
          ? `🧊 Streak freeze used to save your streak! You earned ${pointsReward} points! Streak: ${newStreak} days`
          : `You earned ${pointsReward} points! Streak: ${newStreak} days`,
        'reward'
      ]
    });

    res.json({ message: 'Checked in!', streak: newStreak, pointsEarned: pointsReward, xpEarned: xpReward, newLevel, usedFreeze, streakFreezesRemaining: freezesLeft });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
