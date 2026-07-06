const { createNotification } = require('./notifications');
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { protect, adminOnly } = require('../middleware/auth');
const { progressMission } = require('../utils/missions');

// GET /api/posts — paginated feed (optionally filtered to a group)
router.get('/', protect, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;
    const groupId = req.query.groupId || null;

    const posts = await db.execute({
      sql: `SELECT p.id, p.content, p.media_url, p.created_at, p.group_id, p.poll_options,
                   u.id as author_id, u.username as author_username, u.avatar as author_avatar,
                   (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
                   (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count
            FROM posts p
            JOIN users u ON p.author_id = u.id
            WHERE ${groupId ? 'p.group_id = ?' : 'p.group_id IS NULL'}
            ORDER BY p.created_at DESC
            LIMIT ? OFFSET ?`,
      args: groupId ? [groupId, limit, offset] : [limit, offset]
    });

    // Check if current user liked each post
    const postIds = posts.rows.map(p => p.id);
    let likedSet = new Set();
    let voteMap = {};
    if (postIds.length > 0) {
      const liked = await db.execute({
        sql: `SELECT post_id FROM likes WHERE user_id = ? AND post_id IN (${postIds.map(() => '?').join(',')})`,
        args: [req.user.id, ...postIds]
      });
      likedSet = new Set(liked.rows.map(r => r.post_id));

      const votes = await db.execute({
        sql: `SELECT post_id, option_index FROM poll_votes WHERE user_id = ? AND post_id IN (${postIds.map(() => '?').join(',')})`,
        args: [req.user.id, ...postIds]
      });
      voteMap = Object.fromEntries(votes.rows.map(v => [v.post_id, v.option_index]));
    }

    const result = posts.rows.map(p => {
      let poll = null;
      if (p.poll_options) {
        try {
          const options = JSON.parse(p.poll_options);
          poll = { options, myVote: voteMap[p.id] ?? null };
        } catch (e) { /* corrupt poll data, skip */ }
      }
      return {
        id: p.id,
        content: p.content,
        mediaUrl: p.media_url,
        createdAt: p.created_at,
        groupId: p.group_id,
        poll,
        author: { id: p.author_id, username: p.author_username, avatar: p.author_avatar },
        likeCount: p.like_count,
        commentCount: p.comment_count,
        liked: likedSet.has(p.id)
      };
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/posts — create post (optionally a poll, optionally inside a group)
router.post('/', protect, async (req, res) => {
  try {
    const { content, mediaUrl, groupId, pollOptions } = req.body;
    if (!content) return res.status(400).json({ message: 'Content is required' });

    let pollData = null;
    if (Array.isArray(pollOptions) && pollOptions.filter(o => o && o.trim()).length >= 2) {
      pollData = JSON.stringify(pollOptions.filter(o => o && o.trim()).slice(0, 6).map(text => ({ text, votes: 0 })));
    }

    const id = uuidv4();
    await db.execute({
      sql: 'INSERT INTO posts (id, author_id, content, media_url, group_id, poll_options) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, req.user.id, content, mediaUrl || '', groupId || null, pollData]
    });

    await progressMission(req.user.id, 'post_create', 1);

    res.status(201).json({
      id,
      content,
      mediaUrl: mediaUrl || '',
      groupId: groupId || null,
      poll: pollData ? { options: JSON.parse(pollData), myVote: null } : null,
      author: { id: req.user.id, username: req.user.username, avatar: req.user.avatar },
      likeCount: 0,
      commentCount: 0,
      liked: false
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/posts/:id/report — { reason }
router.post('/:id/report', protect, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || !reason.trim()) return res.status(400).json({ message: 'A reason is required' });
    const post = await db.execute({ sql: 'SELECT id FROM posts WHERE id = ?', args: [req.params.id] });
    if (post.rows.length === 0) return res.status(404).json({ message: 'Post not found' });

    await db.execute({
      sql: 'INSERT INTO reports (id, reporter_id, target_type, target_id, reason) VALUES (?, ?, ?, ?, ?)',
      args: [uuidv4(), req.user.id, 'post', req.params.id, reason.trim()]
    });
    res.status(201).json({ message: 'Report submitted — our team will review it' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});
router.post('/:id/vote', protect, async (req, res) => {
  try {
    const { optionIndex } = req.body;
    const post = await db.execute({ sql: 'SELECT poll_options FROM posts WHERE id = ?', args: [req.params.id] });
    if (post.rows.length === 0 || !post.rows[0].poll_options) return res.status(404).json({ message: 'Poll not found' });

    const existing = await db.execute({ sql: 'SELECT 1 FROM poll_votes WHERE post_id = ? AND user_id = ?', args: [req.params.id, req.user.id] });
    if (existing.rows.length > 0) return res.status(400).json({ message: 'You already voted on this poll' });

    const options = JSON.parse(post.rows[0].poll_options);
    if (optionIndex < 0 || optionIndex >= options.length) return res.status(400).json({ message: 'Invalid option' });
    options[optionIndex].votes += 1;

    await db.execute({ sql: 'UPDATE posts SET poll_options = ? WHERE id = ?', args: [JSON.stringify(options), req.params.id] });
    await db.execute({ sql: 'INSERT INTO poll_votes (post_id, user_id, option_index) VALUES (?, ?, ?)', args: [req.params.id, req.user.id, optionIndex] });

    res.json({ options, myVote: optionIndex });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/posts/:id/like — toggle like
router.put('/:id/like', protect, async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;

    const existing = await db.execute({
      sql: 'SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?',
      args: [postId, userId]
    });

    if (existing.rows.length > 0) {
      await db.execute({ sql: 'DELETE FROM likes WHERE post_id = ? AND user_id = ?', args: [postId, userId] });
    } else {
      await db.execute({ sql: 'INSERT INTO likes (post_id, user_id) VALUES (?, ?)', args: [postId, userId] });
      // Notify post author
      const postRow = await db.execute({ sql: 'SELECT author_id FROM posts WHERE id = ?', args: [postId] });
      if (postRow.rows.length > 0 && postRow.rows[0].author_id !== userId) {
        await createNotification(postRow.rows[0].author_id, '❤️ New Like', `${req.user.username} liked your post.`, 'info');
      }
    }

    const count = await db.execute({
      sql: 'SELECT COUNT(*) as total FROM likes WHERE post_id = ?',
      args: [postId]
    });

    res.json({ likes: count.rows[0].total, liked: existing.rows.length === 0 });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/posts/:id/comment
router.post('/:id/comment', protect, async (req, res) => {
  try {
    const { text } = req.body;
    const postId = req.params.id;

    const post = await db.execute({ sql: 'SELECT id FROM posts WHERE id = ?', args: [postId] });
    if (post.rows.length === 0) return res.status(404).json({ message: 'Post not found' });

    const id = uuidv4();
    await db.execute({
      sql: 'INSERT INTO comments (id, post_id, author_id, text) VALUES (?, ?, ?, ?)',
      args: [id, postId, req.user.id, text]
    });
    // Notify post author
    const postAuthor = await db.execute({ sql: 'SELECT author_id FROM posts WHERE id = ?', args: [postId] });
    if (postAuthor.rows.length > 0 && postAuthor.rows[0].author_id !== req.user.id) {
      await createNotification(postAuthor.rows[0].author_id, '💬 New Comment', `${req.user.username} commented on your post.`, 'info');
    }

    const comments = await db.execute({
      sql: `SELECT c.id, c.text, c.created_at, u.id as author_id, u.username, u.avatar
            FROM comments c JOIN users u ON c.author_id = u.id
            WHERE c.post_id = ? ORDER BY c.created_at ASC`,
      args: [postId]
    });

    res.json(comments.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/posts/:id
router.delete('/:id', protect, async (req, res) => {
  try {
    const post = await db.execute({ sql: 'SELECT * FROM posts WHERE id = ?', args: [req.params.id] });
    if (post.rows.length === 0) return res.status(404).json({ message: 'Post not found' });

    if (post.rows[0].author_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ message: 'Not allowed' });

    await db.execute({ sql: 'DELETE FROM posts WHERE id = ?', args: [req.params.id] });
    res.json({ message: 'Post deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});


// GET /api/posts/:id/comments
router.get('/:id/comments', protect, async (req, res) => {
  try {
    const comments = await db.execute({
      sql: `SELECT c.id, c.text, c.created_at, u.id as author_id, u.username, u.avatar
            FROM comments c JOIN users u ON c.author_id = u.id
            WHERE c.post_id = ? ORDER BY c.created_at ASC`,
      args: [req.params.id]
    });
    res.json(comments.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/posts/:id/comments/:cid
router.delete('/:id/comments/:cid', protect, async (req, res) => {
  try {
    const c = await db.execute({ sql: 'SELECT * FROM comments WHERE id = ?', args: [req.params.cid] });
    if (c.rows.length === 0) return res.status(404).json({ message: 'Comment not found' });
    if (c.rows[0].author_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ message: 'Not allowed' });
    await db.execute({ sql: 'DELETE FROM comments WHERE id = ?', args: [req.params.cid] });
    res.json({ message: 'Comment deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
