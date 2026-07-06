const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { protect, adminOnly } = require('../middleware/auth');
const { createNotification } = require('./notifications');

// ── USER ROUTES ────────────────────────────────────────────────────────────────

// GET /api/boost/services — list all active services
router.get('/services', protect, async (req, res) => {
  try {
    const { platform } = req.query;
    let sql = 'SELECT * FROM boost_services WHERE active = 1';
    const args = [];
    if (platform) {
      sql += ' AND platform = ?';
      args.push(platform);
    }
    sql += ' ORDER BY platform, type';
    const result = await db.execute({ sql, args });
    res.json({ services: result.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/boost/order — place an order
router.post('/order', protect, async (req, res) => {
  try {
    const { service_id, link, quantity } = req.body;
    if (!service_id || !link || !quantity) {
      return res.status(400).json({ message: 'service_id, link and quantity are required' });
    }
    if (!Number.isInteger(Number(quantity)) || Number(quantity) < 1) {
      return res.status(400).json({ message: 'quantity must be a positive integer' });
    }

    // Get service
    const svcResult = await db.execute({
      sql: 'SELECT * FROM boost_services WHERE id = ? AND active = 1',
      args: [service_id]
    });
    if (svcResult.rows.length === 0) {
      return res.status(404).json({ message: 'Service not found or inactive' });
    }
    const service = svcResult.rows[0];

    const qty = Number(quantity);
    if (qty < service.min_qty || qty > service.max_qty) {
      return res.status(400).json({
        message: `Quantity must be between ${service.min_qty} and ${service.max_qty}`
      });
    }

    // Calculate cost
    const total_cost = parseFloat(((service.price_per_1000 / 1000) * qty).toFixed(4));

    // Check wallet balance
    const userResult = await db.execute({
      sql: 'SELECT wallet_balance FROM users WHERE id = ?',
      args: [req.user.id]
    });
    const balance = userResult.rows[0].wallet_balance || 0;
    if (balance < total_cost) {
      return res.status(400).json({
        message: `Insufficient balance. You need ${total_cost} COPS but have ${balance} COPS.`
      });
    }

    // Deduct wallet
    const newBalance = parseFloat((balance - total_cost).toFixed(4));
    await db.execute({
      sql: 'UPDATE users SET wallet_balance = ? WHERE id = ?',
      args: [newBalance, req.user.id]
    });

    // Record transaction
    await db.execute({
      sql: 'INSERT INTO wallet_transactions (id, user_id, type, amount, description) VALUES (?, ?, ?, ?, ?)',
      args: [
        uuidv4(), req.user.id, 'deduct', total_cost,
        `Boost order: ${service.platform} ${service.type} x${qty}`
      ]
    });

    // Create order
    const orderId = uuidv4();
    await db.execute({
      sql: `INSERT INTO boost_orders
              (id, user_id, service_id, platform, type, link, quantity, total_cost, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      args: [orderId, req.user.id, service_id, service.platform, service.type, link, qty, total_cost]
    });

    // Notify user
    await createNotification(
      req.user.id,
      '📦 Boost Order Placed',
      `Your order for ${service.platform} ${service.type} x${qty} is pending. Cost: ${total_cost} COPS.`,
      'info'
    );

    res.status(201).json({
      message: 'Order placed successfully',
      order_id: orderId,
      total_cost,
      new_balance: newBalance
    });
  } catch (err) {
    console.error('Boost order error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/boost/orders — user's own orders
router.get('/orders', protect, async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT o.*, s.name as service_name
            FROM boost_orders o
            LEFT JOIN boost_services s ON o.service_id = s.id
            WHERE o.user_id = ?
            ORDER BY o.created_at DESC
            LIMIT 50`,
      args: [req.user.id]
    });
    res.json({ orders: result.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── ADMIN ROUTES ───────────────────────────────────────────────────────────────

// GET /api/boost/admin/orders — all orders
router.get('/admin/orders', protect, adminOnly, async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `SELECT o.*, u.username, u.email, s.name as service_name
               FROM boost_orders o
               JOIN users u ON o.user_id = u.id
               LEFT JOIN boost_services s ON o.service_id = s.id`;
    const args = [];
    if (status) {
      sql += ' WHERE o.status = ?';
      args.push(status);
    }
    sql += ' ORDER BY o.created_at DESC LIMIT 200';
    const result = await db.execute({ sql, args });
    res.json({ orders: result.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/boost/admin/orders/:id — update order status
router.put('/admin/orders/:id', protect, adminOnly, async (req, res) => {
  try {
    const { status, admin_note } = req.body;
    const validStatuses = ['pending', 'in_progress', 'completed', 'cancelled', 'refunded'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const orderResult = await db.execute({
      sql: 'SELECT * FROM boost_orders WHERE id = ?',
      args: [req.params.id]
    });
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ message: 'Order not found' });
    }
    const order = orderResult.rows[0];

    await db.execute({
      sql: `UPDATE boost_orders SET status = ?, admin_note = ?, updated_at = datetime('now') WHERE id = ?`,
      args: [status, admin_note || order.admin_note || '', req.params.id]
    });

    // Refund if cancelled or refunded
    if ((status === 'cancelled' || status === 'refunded') && order.status !== 'refunded' && order.status !== 'cancelled') {
      const userResult = await db.execute({
        sql: 'SELECT wallet_balance FROM users WHERE id = ?',
        args: [order.user_id]
      });
      const newBalance = parseFloat(((userResult.rows[0].wallet_balance || 0) + order.total_cost).toFixed(4));
      await db.execute({
        sql: 'UPDATE users SET wallet_balance = ? WHERE id = ?',
        args: [newBalance, order.user_id]
      });
      await db.execute({
        sql: 'INSERT INTO wallet_transactions (id, user_id, type, amount, description) VALUES (?, ?, ?, ?, ?)',
        args: [uuidv4(), order.user_id, 'topup', order.total_cost, `Refund: boost order #${req.params.id.slice(0, 8)}`]
      });
      await createNotification(
        order.user_id,
        '💸 Boost Order Refunded',
        `Your order was ${status}. ${order.total_cost} COPS refunded to your wallet.`,
        'warn'
      );
    } else {
      // Notify status change
      const statusEmoji = { in_progress: '⚡', completed: '✅', pending: '📦' };
      await createNotification(
        order.user_id,
        `${statusEmoji[status] || '🔔'} Boost Order ${status.replace('_', ' ')}`,
        `Your ${order.platform} ${order.type} x${order.quantity} order is now ${status}.${admin_note ? ' Note: ' + admin_note : ''}`,
        status === 'completed' ? 'success' : 'info'
      );
    }

    res.json({ message: 'Order updated' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/boost/admin/services — all services (including inactive)
router.get('/admin/services', protect, adminOnly, async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM boost_services ORDER BY platform, type');
    res.json({ services: result.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/boost/admin/services — create service
router.post('/admin/services', protect, adminOnly, async (req, res) => {
  try {
    const { name, platform, type, price_per_1000, min_qty, max_qty, description } = req.body;
    if (!name || !platform || !type || !price_per_1000) {
      return res.status(400).json({ message: 'name, platform, type and price_per_1000 are required' });
    }
    const validPlatforms = ['facebook', 'tiktok', 'instagram', 'youtube'];
    if (!validPlatforms.includes(platform.toLowerCase())) {
      return res.status(400).json({ message: 'Platform must be: facebook, tiktok, instagram, youtube' });
    }
    const id = uuidv4();
    await db.execute({
      sql: `INSERT INTO boost_services (id, name, platform, type, price_per_1000, min_qty, max_qty, description)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, name, platform.toLowerCase(), type.toLowerCase(),
        parseFloat(price_per_1000), parseInt(min_qty) || 100,
        parseInt(max_qty) || 10000, description || ''
      ]
    });
    const result = await db.execute({ sql: 'SELECT * FROM boost_services WHERE id = ?', args: [id] });
    res.status(201).json({ message: 'Service created', service: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/boost/admin/services/:id — update service
router.put('/admin/services/:id', protect, adminOnly, async (req, res) => {
  try {
    const { name, price_per_1000, min_qty, max_qty, description, active } = req.body;
    await db.execute({
      sql: `UPDATE boost_services
            SET name = COALESCE(?, name),
                price_per_1000 = COALESCE(?, price_per_1000),
                min_qty = COALESCE(?, min_qty),
                max_qty = COALESCE(?, max_qty),
                description = COALESCE(?, description),
                active = COALESCE(?, active)
            WHERE id = ?`,
      args: [
        name || null,
        price_per_1000 != null ? parseFloat(price_per_1000) : null,
        min_qty != null ? parseInt(min_qty) : null,
        max_qty != null ? parseInt(max_qty) : null,
        description || null,
        active != null ? (active ? 1 : 0) : null,
        req.params.id
      ]
    });
    const result = await db.execute({ sql: 'SELECT * FROM boost_services WHERE id = ?', args: [req.params.id] });
    res.json({ message: 'Service updated', service: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/boost/admin/services/:id
router.delete('/admin/services/:id', protect, adminOnly, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM boost_services WHERE id = ?', args: [req.params.id] });
    res.json({ message: 'Service deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/boost/admin/stats
router.get('/admin/stats', protect, adminOnly, async (req, res) => {
  try {
    const total = await db.execute('SELECT COUNT(*) as count, COALESCE(SUM(total_cost),0) as revenue FROM boost_orders');
    const pending = await db.execute("SELECT COUNT(*) as count FROM boost_orders WHERE status='pending'");
    const inProgress = await db.execute("SELECT COUNT(*) as count FROM boost_orders WHERE status='in_progress'");
    const completed = await db.execute("SELECT COUNT(*) as count FROM boost_orders WHERE status='completed'");
    res.json({
      total_orders: total.rows[0].count,
      total_revenue: total.rows[0].revenue,
      pending: pending.rows[0].count,
      in_progress: inProgress.rows[0].count,
      completed: completed.rows[0].count
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
