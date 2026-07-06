const { createNotification } = require('./notifications');
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { protect, adminOnly } = require('../middleware/auth');

// All admin routes require auth + admin role
router.use(protect, adminOnly);

// ── USERS ─────────────────────────────────────────
// GET /api/admin/users?search=
router.get('/users', async (req, res) => {
  try {
    const { search } = req.query;
    const result = search
      ? await db.execute({
          sql: `SELECT id, username, email, role, avatar, bio, wallet_balance, is_verified,
                       account_status, warning_count, suspended_until, created_at
                FROM users WHERE username LIKE ? OR email LIKE ? ORDER BY created_at DESC LIMIT 100`,
          args: [`%${search}%`, `%${search}%`]
        })
      : await db.execute(
          `SELECT id, username, email, role, avatar, bio, wallet_balance, is_verified,
                  account_status, warning_count, suspended_until, created_at
           FROM users ORDER BY created_at DESC LIMIT 100`
        );
    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/users/:id/warn — { reason }
router.post('/users/:id/warn', async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE users SET warning_count = warning_count + 1 WHERE id = ?', args: [req.params.id] });
    await createNotification(req.params.id, '⚠ Warning from Admin', req.body.reason || 'Please review our community guidelines.', 'warn');
    res.json({ message: 'Warning issued' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/users/:id/suspend — { days, reason }
router.post('/users/:id/suspend', async (req, res) => {
  try {
    const days = parseInt(req.body.days, 10) || 7;
    const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    await db.execute({ sql: "UPDATE users SET account_status = 'suspended', suspended_until = ? WHERE id = ?", args: [until, req.params.id] });
    await createNotification(req.params.id, '⛔ Account Suspended', `Your account is suspended for ${days} day(s)${req.body.reason ? ': ' + req.body.reason : ''}.`, 'warn');
    res.json({ message: `User suspended for ${days} day(s)` });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/users/:id/ban — { reason }
router.post('/users/:id/ban', async (req, res) => {
  try {
    await db.execute({ sql: "UPDATE users SET account_status = 'banned' WHERE id = ?", args: [req.params.id] });
    res.json({ message: 'User banned' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/users/:id/unban
router.post('/users/:id/unban', async (req, res) => {
  try {
    await db.execute({ sql: "UPDATE users SET account_status = 'active', suspended_until = NULL WHERE id = ?", args: [req.params.id] });
    res.json({ message: 'User reinstated' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [req.params.id] });
    res.json({ message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/admin/users/:id/role
router.put('/users/:id/role', async (req, res) => {
  try {
    const { role } = req.body;
    if (!['user', 'admin'].includes(role)) return res.status(400).json({ message: 'Invalid role' });
    await db.execute({ sql: 'UPDATE users SET role = ? WHERE id = ?', args: [role, req.params.id] });
    res.json({ message: 'Role updated' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/wallet/topup
router.post('/wallet/topup', async (req, res) => {
  try {
    const { userId, amount, description } = req.body;
    if (!userId || !amount || isNaN(amount)) return res.status(400).json({ message: 'userId and amount required' });
    const result = await db.execute({ sql: 'SELECT wallet_balance FROM users WHERE id = ?', args: [userId] });
    if (result.rows.length === 0) return res.status(404).json({ message: 'User not found' });
    const newBalance = (result.rows[0].wallet_balance || 0) + parseFloat(amount);
    await db.execute({ sql: 'UPDATE users SET wallet_balance = ? WHERE id = ?', args: [newBalance, userId] });
    await db.execute({
      sql: 'INSERT INTO wallet_transactions (id, user_id, type, amount, description) VALUES (?, ?, ?, ?, ?)',
      args: [uuidv4(), userId, 'topup', parseFloat(amount), description || 'Admin top-up']
    });
    await createNotification(userId, '⚡ COPS Added to Your Wallet', `${parseFloat(amount)} COPS have been added. New balance: ${newBalance} COPS.`, 'success');
    res.json({ message: 'Wallet topped up', balance: newBalance });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/wallet/deduct
router.post('/wallet/deduct', async (req, res) => {
  try {
    const { userId, amount, description } = req.body;
    if (!userId || !amount || isNaN(amount)) return res.status(400).json({ message: 'userId and amount required' });
    const result = await db.execute({ sql: 'SELECT wallet_balance FROM users WHERE id = ?', args: [userId] });
    if (result.rows.length === 0) return res.status(404).json({ message: 'User not found' });
    const newBalance = Math.max(0, (result.rows[0].wallet_balance || 0) - parseFloat(amount));
    await db.execute({ sql: 'UPDATE users SET wallet_balance = ? WHERE id = ?', args: [newBalance, userId] });
    await db.execute({
      sql: 'INSERT INTO wallet_transactions (id, user_id, type, amount, description) VALUES (?, ?, ?, ?, ?)',
      args: [uuidv4(), userId, 'deduct', parseFloat(amount), description || 'Admin deduction']
    });
    await createNotification(userId, '⚠ COPS Deducted', `${parseFloat(amount)} COPS were deducted. New balance: ${newBalance} COPS.`, 'warn');
    res.json({ message: 'Wallet deducted', balance: newBalance });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── WITHDRAWALS ───────────────────────────────────
// GET /api/admin/withdrawals?status=pending
router.get('/withdrawals', async (req, res) => {
  try {
    const status = req.query.status;
    const result = status
      ? await db.execute({
          sql: `SELECT w.*, u.username, u.email FROM withdrawals w JOIN users u ON u.id = w.user_id
                WHERE w.status = ? ORDER BY w.created_at DESC`,
          args: [status]
        })
      : await db.execute(
          `SELECT w.*, u.username, u.email FROM withdrawals w JOIN users u ON u.id = w.user_id ORDER BY w.created_at DESC`
        );
    res.json({ withdrawals: result.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/withdrawals/:id/approve
router.post('/withdrawals/:id/approve', async (req, res) => {
  try {
    const w = await db.execute({ sql: 'SELECT * FROM withdrawals WHERE id = ?', args: [req.params.id] });
    if (w.rows.length === 0) return res.status(404).json({ message: 'Withdrawal not found' });
    if (w.rows[0].status !== 'pending') return res.status(400).json({ message: 'Already resolved' });

    await db.execute({
      sql: `UPDATE withdrawals SET status = 'approved', resolved_at = datetime('now'), admin_note = ? WHERE id = ?`,
      args: [req.body.note || '', req.params.id]
    });
    await createNotification(w.rows[0].user_id, '✅ Withdrawal Approved', `Your withdrawal of ⚡${w.rows[0].amount} COPS has been approved and sent via ${w.rows[0].method}.`, 'success');
    res.json({ message: 'Withdrawal approved' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/withdrawals/:id/reject — refunds the held balance
router.post('/withdrawals/:id/reject', async (req, res) => {
  try {
    const w = await db.execute({ sql: 'SELECT * FROM withdrawals WHERE id = ?', args: [req.params.id] });
    if (w.rows.length === 0) return res.status(404).json({ message: 'Withdrawal not found' });
    if (w.rows[0].status !== 'pending') return res.status(400).json({ message: 'Already resolved' });

    await db.execute({
      sql: `UPDATE withdrawals SET status = 'rejected', resolved_at = datetime('now'), admin_note = ? WHERE id = ?`,
      args: [req.body.note || '', req.params.id]
    });
    // Refund the held COPS back to the user
    await db.execute({ sql: 'UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', args: [w.rows[0].amount, w.rows[0].user_id] });
    await db.execute({
      sql: `INSERT INTO wallet_transactions (id, user_id, type, amount, description) VALUES (?, ?, 'refund', ?, 'Withdrawal rejected — funds returned')`,
      args: [uuidv4(), w.rows[0].user_id, w.rows[0].amount]
    });
    await createNotification(w.rows[0].user_id, '⚠ Withdrawal Rejected', `Your withdrawal request was rejected${req.body.note ? ': ' + req.body.note : ''}. ⚡${w.rows[0].amount} COPS has been returned to your wallet.`, 'warn');
    res.json({ message: 'Withdrawal rejected and refunded' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── COUPONS ───────────────────────────────────────
// GET /api/admin/coupons
router.get('/coupons', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM coupons ORDER BY created_at DESC');
    res.json({ coupons: result.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/coupons — create a coupon or gift card (max_uses:1 = single-use gift card)
router.post('/coupons', async (req, res) => {
  try {
    const { code, type, value, maxUses, expiresAt } = req.body;
    if (!code || !value) return res.status(400).json({ message: 'code and value are required' });
    const normalizedCode = code.trim().toUpperCase();
    await db.execute({
      sql: 'INSERT INTO coupons (code, type, value, max_uses, expires_at) VALUES (?, ?, ?, ?, ?)',
      args: [normalizedCode, type === 'points' ? 'points' : 'cops', parseInt(value, 10), parseInt(maxUses, 10) || 1, expiresAt || null]
    });
    res.json({ message: 'Coupon created', code: normalizedCode });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(400).json({ message: 'Coupon code already exists' });
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/admin/coupons/:code/deactivate
router.put('/coupons/:code/deactivate', async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE coupons SET active = 0 WHERE code = ?', args: [req.params.code.toUpperCase()] });
    res.json({ message: 'Coupon deactivated' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── NEWS ──────────────────────────────────────────
// GET /api/admin/news
router.get('/news', async (req, res) => {
  try {
    const result = await db.execute(
      'SELECT * FROM news ORDER BY created_at DESC'
    );
    res.json({ news: result.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/news
router.post('/news', async (req, res) => {
  try {
    const { title, body, icon, color, category } = req.body;
    if (!title || !body) return res.status(400).json({ message: 'title and body required' });
    const id = uuidv4();
    await db.execute({
      sql: 'INSERT INTO news (id, title, body, icon, color, category, author_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [id, title, body, icon || 'newspaper', color || '#00ffcc', category || 'general', req.user.id]
    });
    const result = await db.execute({ sql: 'SELECT * FROM news WHERE id = ?', args: [id] });
    res.status(201).json({ message: 'News created', news: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/admin/news/:id
router.put('/news/:id', async (req, res) => {
  try {
    const { title, body, icon, color, category } = req.body;
    await db.execute({
      sql: 'UPDATE news SET title=COALESCE(?,title), body=COALESCE(?,body), icon=COALESCE(?,icon), color=COALESCE(?,color), category=COALESCE(?,category) WHERE id=?',
      args: [title||null, body||null, icon||null, color||null, category||null, req.params.id]
    });
    const result = await db.execute({ sql: 'SELECT * FROM news WHERE id = ?', args: [req.params.id] });
    res.json({ message: 'News updated', news: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/admin/news/:id
router.delete('/news/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM news WHERE id = ?', args: [req.params.id] });
    res.json({ message: 'News deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── POSTS ─────────────────────────────────────────
// GET /api/admin/posts
router.get('/posts', async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT p.id, p.content, p.media_url, p.created_at,
                   u.id as author_id, u.username as author_username
            FROM posts p JOIN users u ON p.author_id = u.id
            ORDER BY p.created_at DESC LIMIT 100`
    });
    res.json({ posts: result.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/admin/posts/:id
router.delete('/posts/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM posts WHERE id = ?', args: [req.params.id] });
    res.json({ message: 'Post deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/posts — post as admin/announcement
router.post('/posts', async (req, res) => {
  try {
    const { content, mediaUrl } = req.body;
    if (!content) return res.status(400).json({ message: 'Content required' });
    const id = uuidv4();
    await db.execute({
      sql: 'INSERT INTO posts (id, author_id, content, media_url) VALUES (?, ?, ?, ?)',
      args: [id, req.user.id, content, mediaUrl || '']
    });
    res.status(201).json({ message: 'Post created', id });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── STATS ─────────────────────────────────────────
// GET /api/admin/stats
router.get('/stats', async (req, res) => {
  try {
    const users = await db.execute('SELECT COUNT(*) as total FROM users');
    const verified = await db.execute('SELECT COUNT(*) as total FROM users WHERE is_verified=1');
    const posts = await db.execute('SELECT COUNT(*) as total FROM posts');
    const news = await db.execute('SELECT COUNT(*) as total FROM news');
    const totalCops = await db.execute('SELECT COALESCE(SUM(wallet_balance),0) as total FROM users');
    const pendingWithdrawals = await db.execute("SELECT COUNT(*) as c, COALESCE(SUM(amount),0) as total FROM withdrawals WHERE status = 'pending'");
    const paidPlans = await db.execute("SELECT COUNT(*) as c FROM users WHERE plan != 'free' AND (plan_expires_at IS NULL OR plan_expires_at > datetime('now'))");
    const activeListings = await db.execute("SELECT COUNT(*) as c FROM bot_listings WHERE status = 'active'");
    const pendingReports = await db.execute("SELECT COUNT(*) as c FROM reports WHERE status = 'pending'");
    res.json({
      totalUsers: users.rows[0].total,
      verifiedUsers: verified.rows[0].total,
      totalPosts: posts.rows[0].total,
      totalNews: news.rows[0].total,
      totalCopsInCirculation: totalCops.rows[0].total,
      pendingWithdrawals: pendingWithdrawals.rows[0].c,
      pendingWithdrawalAmount: pendingWithdrawals.rows[0].total,
      activePremiumUsers: paidPlans.rows[0].c,
      activeMarketplaceListings: activeListings.rows[0].c,
      pendingReports: pendingReports.rows[0].c
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── ANNOUNCEMENTS (broadcast post) ────────────────
// POST /api/admin/announce — pin a message to top of feed
router.post('/announce', async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ message: 'Content required' });
    // Clear old pinned posts
    await db.execute({ sql: 'UPDATE posts SET pinned=0 WHERE pinned=1' });
    const id = uuidv4();
    await db.execute({
      sql: 'INSERT INTO posts (id, author_id, content, media_url, pinned) VALUES (?, ?, ?, ?, 1)',
      args: [id, req.user.id, content, '']
    });
    res.status(201).json({ message: 'Announcement posted', id });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── REPORTS ───────────────────────────────────────
// GET /api/admin/reports?status=pending
router.get('/reports', async (req, res) => {
  try {
    const status = req.query.status;
    const result = status
      ? await db.execute({
          sql: `SELECT r.*, u.username as reporter_username FROM reports r
                JOIN users u ON u.id = r.reporter_id WHERE r.status = ? ORDER BY r.created_at DESC`,
          args: [status]
        })
      : await db.execute(
          `SELECT r.*, u.username as reporter_username FROM reports r
           JOIN users u ON u.id = r.reporter_id ORDER BY r.created_at DESC LIMIT 100`
        );
    res.json({ reports: result.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/admin/reports/:id/resolve — { action: 'dismiss'|'actioned' }
router.put('/reports/:id/resolve', async (req, res) => {
  try {
    const status = req.body.action === 'actioned' ? 'actioned' : 'dismissed';
    await db.execute({
      sql: `UPDATE reports SET status = ?, resolved_at = datetime('now') WHERE id = ?`,
      args: [status, req.params.id]
    });
    res.json({ message: 'Report resolved' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── AI USAGE ──────────────────────────────────────
// GET /api/admin/ai-usage
router.get('/ai-usage', async (req, res) => {
  try {
    const totalGenerations = await db.execute('SELECT COUNT(*) as c FROM ai_generations');
    const byTool = await db.execute(`SELECT tool, COUNT(*) as count FROM ai_generations GROUP BY tool ORDER BY count DESC`);
    const topUsers = await db.execute(`
      SELECT u.username, COUNT(*) as count FROM ai_generations g
      JOIN users u ON u.id = g.user_id GROUP BY g.user_id ORDER BY count DESC LIMIT 10
    `);
    const last7Days = await db.execute(`
      SELECT date(created_at) as day, COUNT(*) as count FROM ai_generations
      WHERE created_at >= datetime('now', '-7 days') GROUP BY day ORDER BY day ASC
    `);
    res.json({ totalGenerations: totalGenerations.rows[0].c, byTool: byTool.rows, topUsers: topUsers.rows, last7Days: last7Days.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── MARKETPLACE MODERATION ────────────────────────
// GET /api/admin/marketplace/listings — includes removed/inactive listings
router.get('/marketplace/listings', async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT l.*, u.username as seller_username FROM bot_listings l
      JOIN users u ON u.id = l.seller_id ORDER BY l.created_at DESC
    `);
    res.json({ listings: result.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/admin/marketplace/listings/:id/status — { status }
router.put('/marketplace/listings/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'removed'].includes(status)) return res.status(400).json({ message: 'Invalid status' });
    await db.execute({ sql: 'UPDATE bot_listings SET status = ? WHERE id = ?', args: [status, req.params.id] });
    res.json({ message: 'Listing updated' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
