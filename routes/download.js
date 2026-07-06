const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { optionalAuth } = require('../middleware/auth');

// ── Jamendo (licensed, royalty-free music — replaces the old drexapp/YouTube-rip source) ──
// Docs: https://developer.jamendo.com/v3.0
// Requires a free client_id from https://devportal.jamendo.com — set as JAMENDO_CLIENT_ID.
const JAMENDO_BASE = 'https://api.jamendo.com/v3.0/tracks/';

function jamendoClientId() {
  return process.env.JAMENDO_CLIENT_ID || '';
}

function formatDuration(seconds) {
  const s = parseInt(seconds, 10);
  if (!s && s !== 0) return '';
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, '0')}`;
}

// Normalizes a raw Jamendo track object into the shape the frontend renders.
function mapTrack(t) {
  return {
    id: t.id,
    title: t.name,
    artist: t.artist_name,
    album: t.album_name || '',
    thumb: t.image || t.album_image || '',
    duration: formatDuration(t.duration),
    // Jamendo lets each artist opt in/out of downloads — respect that per-track flag
    dl_url: t.audiodownload_allowed ? t.audiodownload : '',
    stream_url: t.audio || '',
    license: t.license_ccurl || ''
  };
}

async function jamendoFetch(params) {
  const clientId = jamendoClientId();
  if (!clientId) {
    const err = new Error('Music service is not configured (missing JAMENDO_CLIENT_ID).');
    err.code = 'NO_CLIENT_ID';
    throw err;
  }
  const qs = new URLSearchParams({
    client_id: clientId,
    format: 'json',
    include: 'musicinfo',
    audioformat: 'mp32',
    ...params
  });
  const r = await fetch(`${JAMENDO_BASE}?${qs.toString()}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('Jamendo API error');
  const data = await r.json();
  if (data?.headers?.status !== 'success') throw new Error(data?.headers?.error_message || 'Jamendo API error');
  return data.results || [];
}

// ── Search tracks ──
// GET /api/download/song?query=Faded&limit=20
router.get('/song', async (req, res) => {
  const { query, limit } = req.query;
  if (!query) return res.status(400).json({ error: 'query is required' });

  try {
    const results = await jamendoFetch({
      search: query,
      limit: Math.min(parseInt(limit, 10) || 20, 50)
    });
    return res.json({ status: true, results: results.map(mapTrack) });
  } catch (e) {
    if (e.code === 'NO_CLIENT_ID') return res.status(503).json({ error: e.message });
    return res.status(502).json({ error: 'Music search unavailable. Try again shortly.' });
  }
});

// ── Top / popular tracks (for the default Music page view) ──
// GET /api/download/top?limit=20
router.get('/top', async (req, res) => {
  const { limit } = req.query;
  try {
    const results = await jamendoFetch({
      order: 'popularity_month',
      limit: Math.min(parseInt(limit, 10) || 20, 50)
    });
    return res.json({ status: true, results: results.map(mapTrack) });
  } catch (e) {
    if (e.code === 'NO_CLIENT_ID') return res.status(503).json({ error: e.message });
    return res.status(502).json({ error: 'Music service unavailable. Try again shortly.' });
  }
});

// ── Log a play/download (fire-and-forget analytics; Jamendo URLs are hit directly by the client) ──
// POST /api/download   Body: { title, trackId, action }  action = 'play' | 'download'
router.post('/', optionalAuth, async (req, res) => {
  const { title, trackId, action } = req.body || {};
  if (!title && !trackId) return res.status(400).json({ error: 'title or trackId is required' });

  if (req.user) {
    db.execute({
      sql: 'INSERT INTO download_log (id, user_id, query, source) VALUES (?, ?, ?, ?)',
      args: [uuidv4(), req.user.id, title || trackId, action === 'download' ? 'music_download' : 'music_play']
    }).catch(() => {}); // fire-and-forget — a logging failure shouldn't block the user
  }

  return res.json({ status: true });
});

module.exports = router;
