const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');

function dailyKey() {
  return new Date().toISOString().slice(0, 10);
}

function weeklyKey() {
  const d = new Date();
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNr = (target.getUTCDay() + 6) % 7; // Monday = 0
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function periodKeyFor(missionType) {
  return missionType === 'weekly' || missionType === 'monthly' ? weeklyKey() : dailyKey();
}

/**
 * Advances progress on all active missions matching `action` for a user.
 * Auto-completes + credits rewards + notifies the first time a mission crosses its target.
 * Safe to call from anywhere a trackable action happens (post created, spin used, etc).
 */
async function progressMission(userId, action, amount = 1) {
  try {
    const missions = await db.execute({
      sql: 'SELECT * FROM missions WHERE target_action = ? AND active = 1',
      args: [action]
    });

    for (const mission of missions.rows) {
      const periodKey = periodKeyFor(mission.type);

      const existing = await db.execute({
        sql: 'SELECT * FROM user_missions WHERE user_id = ? AND mission_id = ? AND period_key = ?',
        args: [userId, mission.id, periodKey]
      });

      let newProgress;
      if (existing.rows.length === 0) {
        newProgress = Math.min(amount, mission.target_count);
        await db.execute({
          sql: 'INSERT INTO user_missions (id, user_id, mission_id, progress, period_key) VALUES (?, ?, ?, ?, ?)',
          args: [uuidv4(), userId, mission.id, newProgress, periodKey]
        });
      } else {
        const row = existing.rows[0];
        if (row.completed) continue; // already done this period
        newProgress = Math.min(row.progress + amount, mission.target_count);
        await db.execute({
          sql: 'UPDATE user_missions SET progress = ? WHERE id = ?',
          args: [newProgress, row.id]
        });
      }

      if (newProgress >= mission.target_count) {
        await db.execute({
          sql: `UPDATE user_missions SET completed = 1 WHERE user_id = ? AND mission_id = ? AND period_key = ?`,
          args: [userId, mission.id, periodKey]
        });
        if (mission.points_reward || mission.xp_reward) {
          await db.execute({
            sql: 'UPDATE users SET points_balance = points_balance + ?, xp = xp + ? WHERE id = ?',
            args: [mission.points_reward || 0, mission.xp_reward || 0, userId]
          });
        }
        await db.execute({
          sql: `INSERT INTO notifications (id, user_id, title, body, type) VALUES (?, ?, ?, ?, 'reward')`,
          args: [uuidv4(), userId, '✅ Mission Complete!', `"${mission.title}" complete — +${mission.points_reward} points, +${mission.xp_reward} XP`]
        });
      }
    }
  } catch (err) {
    console.error('progressMission error:', err);
  }
}

module.exports = { progressMission, periodKeyFor };
