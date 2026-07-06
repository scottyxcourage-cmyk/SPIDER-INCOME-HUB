const express = require('express');
const router  = express.Router();

const BASE = 'https://apis.davidcyril.name.ng/movies/fzmovies';

// ── Safe fetch with 12s timeout ───────────────────────────────────────────
async function safeFetch(url) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return r;
  } catch (e) { clearTimeout(timer); throw e; }
}

// ── Extract year from title e.g. "Avengers (2019) Movie" → "2019" ─────────
function extractYear(title) {
  const m = (title || '').match(/\((\d{4})\)/);
  return m ? m[1] : '';
}

// ── Clean title e.g. "Avengers (2019) Movie" → "Avengers" ─────────────────
function cleanTitle(title) {
  return (title || '').replace(/\s*\(\d{4}\)\s*/g, '').replace(/\s*Movie\s*$/i, '').trim();
}

// ── Extract genres from categories array ──────────────────────────────────
function extractGenres(cats) {
  if (!Array.isArray(cats)) return [];
  const skip = /movie|download|movies|\d{4}/i;
  return cats
    .filter(c => !skip.test(c))
    .map(c => ({ text: c.replace(/\s+movies?$/i, '').trim() }))
    .filter((g, i, a) => g.text && a.findIndex(x => x.text === g.text) === i)
    .slice(0, 3);
}

// ── Get poster from TMDB (free, no key needed for image search) ────────────
// Falls back to a placeholder if not found
const posterCache = {};
async function getPoster(title, year) {
  const key = `${title}-${year}`;
  if (posterCache[key] !== undefined) return posterCache[key];
  try {
    const q   = encodeURIComponent(cleanTitle(title));
    const url = `https://api.themoviedb.org/3/search/movie?api_key=8265bd1679663a7ea12ac168da84d2e8&query=${q}&year=${year}&language=en-US&page=1`;
    const r   = await safeFetch(url);
    const d   = await r.json();
    const hit = (d.results || [])[0];
    const img = hit?.poster_path ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : '';
    posterCache[key] = img;
    return img;
  } catch (e) {
    posterCache[key] = '';
    return '';
  }
}

// ── Normalize FZMovies result → shape frontend expects ────────────────────
function normalize(m, poster = '') {
  if (!m) return null;
  const year  = extractYear(m.title);
  const title = cleanTitle(m.title);
  return {
    id:                m.slug || m.url,
    titleText:         { text: title },
    originalTitleText: { text: title },
    primaryImage:      { url: poster },
    ratingsSummary:    { aggregateRating: 0 },
    releaseYear:       { year },
    genres:            extractGenres(m.categories),
    plot:              (m.description || '').replace(/&#\d+;/g, '').trim(),
    type:              'Movie',
    downloadUrl:       m.url || '',
    date:              m.date || '',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/movies/trending  — latest movies from FZMovies
// ─────────────────────────────────────────────────────────────────────────
router.get('/trending', async (req, res) => {
  try {
    const r   = await safeFetch(`${BASE}/latest`);
    const d   = await r.json();
    console.log('[Movies] Latest status:', r.status, '| count:', (d.results||[]).length);
    if (!r.ok) return res.status(r.status).json({ error: d.message || 'API error' });

    const list = d.results || [];
    // Fetch posters in parallel (max 5 at a time to avoid hammering TMDB)
    const results = [];
    for (let i = 0; i < list.length; i += 5) {
      const batch = list.slice(i, i + 5);
      const posters = await Promise.all(batch.map(m => getPoster(m.title, extractYear(m.title))));
      batch.forEach((m, j) => results.push(normalize(m, posters[j])));
    }
    res.json({ results: results.filter(Boolean) });
  } catch (e) {
    console.error('[Movies] Trending error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/movies/search?q=avengers
// ─────────────────────────────────────────────────────────────────────────
router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Query required' });
  try {
    const r = await safeFetch(`${BASE}/search?q=${encodeURIComponent(q)}`);
    const d = await r.json();
    console.log('[Movies] Search status:', r.status, '| query:', q, '| count:', (d.results||[]).length);
    if (!r.ok) return res.status(r.status).json({ error: d.message || 'API error' });

    const list = d.results || [];
    const results = [];
    for (let i = 0; i < list.length; i += 5) {
      const batch   = list.slice(i, i + 5);
      const posters = await Promise.all(batch.map(m => getPoster(m.title, extractYear(m.title))));
      batch.forEach((m, j) => results.push(normalize(m, posters[j])));
    }
    res.json({ results: results.filter(Boolean) });
  } catch (e) {
    console.error('[Movies] Search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/movies/:id/actors  — FZMovies has no cast data, return empty
// ─────────────────────────────────────────────────────────────────────────
router.get('/:id/actors', async (req, res) => {
  res.json({ results: [] });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/movies/:id  — movie detail + download links via /info
// ─────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    // id is the slug — reconstruct the fzmovies URL
    const slug    = req.params.id;
    const fzUrl   = slug.startsWith('http') ? slug : `https://fzmovies.ng/${slug}/`;
    const r       = await safeFetch(`${BASE}/info?url=${encodeURIComponent(fzUrl)}`);
    const d       = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: 'Movie not found' });

    // /info returns the movie detail + download links
    const poster  = await getPoster(d.title || slug, extractYear(d.title || ''));
    const movie   = normalize(d, poster);

    // Attach download links if present
    if (d.downloads || d.links) {
      movie.downloads = d.downloads || d.links || [];
    }
    res.json(movie);
  } catch (e) {
    console.error('[Movies] Detail error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
