const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { protect } = require('../middleware/auth');

// GET /api/groups — all groups, with member count and whether current user is a member
router.get('/', protect, async (req, res) => {
  try {
    const groups = await db.execute({
      sql: `SELECT g.*, u.username as creator_username,
                   (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count,
                   (SELECT COUNT(*) FROM group_members WHERE group_id = g.id AND user_id = ?) as is_member
            FROM groups g JOIN users u ON u.id = g.creator_id
            ORDER BY g.created_at DESC`,
      args: [req.user.id]
    });
    res.json(groups.rows.map(g => ({ ...g, is_member: !!g.is_member })));
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/groups/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const g = await db.execute({
      sql: `SELECT g.*, u.username as creator_username,
                   (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count,
                   (SELECT COUNT(*) FROM group_members WHERE group_id = g.id AND user_id = ?) as is_member
            FROM groups g JOIN users u ON u.id = g.creator_id WHERE g.id = ?`,
      args: [req.user.id, req.params.id]
    });
    if (g.rows.length === 0) return res.status(404).json({ message: 'Group not found' });
    res.json({ ...g.rows[0], is_member: !!g.rows[0].is_member });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/groups — create a group (creator auto-joins as admin)
router.post('/', protect, async (req, res) => {
  try {
    const { name, description, coverImage, isPrivate } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ message: 'Group name is required' });

    const id = uuidv4();
    await db.execute({
      sql: 'INSERT INTO groups (id, name, description, cover_image, creator_id, is_private) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, name.trim(), description || '', coverImage || '', req.user.id, isPrivate ? 1 : 0]
    });
    await db.execute({ sql: "INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'admin')", args: [id, req.user.id] });

    res.status(201).json({ id, message: 'Group created' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/groups/:id/join
router.post('/:id/join', protect, async (req, res) => {
  try {
    const existing = await db.execute({ sql: 'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?', args: [req.params.id, req.user.id] });
    if (existing.rows.length > 0) return res.status(400).json({ message: 'Already a member' });
    await db.execute({ sql: 'INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', args: [req.params.id, req.user.id] });
    res.json({ message: 'Joined group' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/groups/:id/leave
router.post('/:id/leave', protect, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM group_members WHERE group_id = ? AND user_id = ?', args: [req.params.id, req.user.id] });
    res.json({ message: 'Left group' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/groups/:id/members
router.get('/:id/members', protect, async (req, res) => {
  try {
    const members = await db.execute({
      sql: `SELECT u.id, u.username, u.avatar, gm.role, gm.joined_at
            FROM group_members gm JOIN users u ON u.id = gm.user_id
            WHERE gm.group_id = ? ORDER BY gm.joined_at ASC`,
      args: [req.params.id]
    });
    res.json(members.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/groups/:id — creator or admin only
router.delete('/:id', protect, async (req, res) => {
  try {
    const g = await db.execute({ sql: 'SELECT creator_id FROM groups WHERE id = ?', args: [req.params.id] });
    if (g.rows.length === 0) return res.status(404).json({ message: 'Group not found' });
    if (g.rows[0].creator_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not allowed' });
    }
    await db.execute({ sql: 'DELETE FROM groups WHERE id = ?', args: [req.params.id] });
    res.json({ message: 'Group deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
