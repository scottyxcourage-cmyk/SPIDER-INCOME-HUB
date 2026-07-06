const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { protect } = require('../middleware/auth');

// All routes require auth
router.use(protect);

// GET /api/messages/conversations — list all conversations for current user
router.get('/conversations', async (req, res) => {
  try {
    const me = req.user.id;
    const result = await db.execute({
      sql: `
        SELECT
          c.id, c.last_message, c.last_at,
          CASE WHEN c.user_a = ? THEN c.unread_a ELSE c.unread_b END AS unread,
          CASE WHEN c.user_a = ? THEN u_b.id ELSE u_a.id END AS other_id,
          CASE WHEN c.user_a = ? THEN u_b.username ELSE u_a.username END AS other_username,
          CASE WHEN c.user_a = ? THEN u_b.avatar ELSE u_a.avatar END AS other_avatar,
          CASE WHEN c.user_a = ? THEN u_b.last_seen ELSE u_a.last_seen END AS other_last_seen
        FROM conversations c
        JOIN users u_a ON c.user_a = u_a.id
        JOIN users u_b ON c.user_b = u_b.id
        WHERE c.user_a = ? OR c.user_b = ?
        ORDER BY c.last_at DESC
      `,
      args: [me, me, me, me, me, me, me]
    });
    res.json({ conversations: result.rows });
  } catch (err) {
    console.error('GET conversations error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/messages/users — search users to start a conversation
router.get('/users', async (req, res) => {
  try {
    const { q } = req.query;
    const me = req.user.id;
    if (!q || q.length < 2) return res.json({ users: [] });
    const result = await db.execute({
      sql: `SELECT id, username, avatar, last_seen FROM users
            WHERE (username LIKE ? OR email LIKE ?) AND id != ?
            LIMIT 10`,
      args: [`%${q}%`, `%${q}%`, me]
    });
    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/messages/conversations — start or get existing conversation
router.post('/conversations', async (req, res) => {
  try {
    const me = req.user.id;
    const { other_id } = req.body;
    if (!other_id) return res.status(400).json({ message: 'other_id required' });
    if (other_id === me) return res.status(400).json({ message: 'Cannot message yourself' });

    // Check user exists
    const userCheck = await db.execute({ sql: 'SELECT id, username, avatar FROM users WHERE id=?', args: [other_id] });
    if (!userCheck.rows.length) return res.status(404).json({ message: 'User not found' });

    // Normalize: user_a always < user_b for UNIQUE constraint
    const [user_a, user_b] = [me, other_id].sort();

    // Try to find existing
    const existing = await db.execute({
      sql: 'SELECT * FROM conversations WHERE user_a=? AND user_b=?',
      args: [user_a, user_b]
    });

    if (existing.rows.length > 0) {
      return res.json({ conversation: existing.rows[0], other: userCheck.rows[0] });
    }

    // Create new
    const id = uuidv4();
    await db.execute({
      sql: 'INSERT INTO conversations (id, user_a, user_b) VALUES (?,?,?)',
      args: [id, user_a, user_b]
    });

    const conv = await db.execute({ sql: 'SELECT * FROM conversations WHERE id=?', args: [id] });
    res.status(201).json({ conversation: conv.rows[0], other: userCheck.rows[0] });
  } catch (err) {
    console.error('POST conversation error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/messages/:convId — get messages in a conversation (paginated)
router.get('/:convId', async (req, res) => {
  try {
    const me = req.user.id;
    const { convId } = req.params;
    const since = req.query.since || '1970-01-01';

    // Verify user is part of this conversation
    const conv = await db.execute({
      sql: 'SELECT * FROM conversations WHERE id=? AND (user_a=? OR user_b=?)',
      args: [convId, me, me]
    });
    if (!conv.rows.length) return res.status(403).json({ message: 'Forbidden' });

    const msgs = await db.execute({
      sql: `SELECT m.id, m.sender_id, m.content, m.type, m.is_read, m.deleted, m.created_at,
                   u.username as sender_name, u.avatar as sender_avatar
            FROM messages m
            JOIN users u ON m.sender_id = u.id
            WHERE m.conversation_id=? AND m.created_at > ?
            ORDER BY m.created_at ASC
            LIMIT 100`,
      args: [convId, since]
    });

    // Mark messages from other user as read
    await db.execute({
      sql: 'UPDATE messages SET is_read=1 WHERE conversation_id=? AND sender_id!=? AND is_read=0',
      args: [convId, me]
    });

    // Reset unread counter for me
    const c = conv.rows[0];
    if (c.user_a === me) {
      await db.execute({ sql: 'UPDATE conversations SET unread_a=0 WHERE id=?', args: [convId] });
    } else {
      await db.execute({ sql: 'UPDATE conversations SET unread_b=0 WHERE id=?', args: [convId] });
    }

    res.json({ messages: msgs.rows, conversation: c });
  } catch (err) {
    console.error('GET messages error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/messages/:convId — send a message
router.post('/:convId', async (req, res) => {
  try {
    const me = req.user.id;
    const { convId } = req.params;
    const { content, type = 'text' } = req.body;

    if (!content || !content.trim()) return res.status(400).json({ message: 'Empty message' });

    // Verify conversation membership
    const conv = await db.execute({
      sql: 'SELECT * FROM conversations WHERE id=? AND (user_a=? OR user_b=?)',
      args: [convId, me, me]
    });
    if (!conv.rows.length) return res.status(403).json({ message: 'Forbidden' });

    const c = conv.rows[0];
    const id = uuidv4();
    const now = new Date().toISOString();

    await db.execute({
      sql: 'INSERT INTO messages (id, conversation_id, sender_id, content, type, created_at) VALUES (?,?,?,?,?,?)',
      args: [id, convId, me, content.trim(), type, now]
    });

    // Update conversation last_message + bump unread for the OTHER person
    const isUserA = c.user_a === me;
    await db.execute({
      sql: `UPDATE conversations SET
              last_message=?, last_at=?,
              unread_a = CASE WHEN user_a != ? THEN unread_a+1 ELSE unread_a END,
              unread_b = CASE WHEN user_b != ? THEN unread_b+1 ELSE unread_b END
            WHERE id=?`,
      args: [content.trim().substring(0, 80), now, me, me, convId]
    });

    const msg = await db.execute({
      sql: `SELECT m.id, m.sender_id, m.content, m.type, m.is_read, m.deleted, m.created_at,
                   u.username as sender_name, u.avatar as sender_avatar
            FROM messages m JOIN users u ON m.sender_id=u.id WHERE m.id=?`,
      args: [id]
    });

    res.status(201).json({ message: msg.rows[0] });
  } catch (err) {
    console.error('POST message error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/messages/:convId/:msgId — soft delete a message
router.delete('/:convId/:msgId', async (req, res) => {
  try {
    const me = req.user.id;
    const { msgId } = req.params;
    await db.execute({
      sql: 'UPDATE messages SET deleted=1, content=\'This message was deleted\' WHERE id=? AND sender_id=?',
      args: [msgId, me]
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/messages/last-seen — update user last_seen
router.put('/last-seen', async (req, res) => {
  try {
    await db.execute({
      sql: "UPDATE users SET last_seen=datetime('now') WHERE id=?",
      args: [req.user.id]
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
