const express = require('express');
const router = express.Router();

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';

const ENDPOINTS = {
  livescores: `${ESPN}/soccer/eng.1/scoreboard`,
  basketball:  `${ESPN}/basketball/nba/scoreboard`,
  cricket:     `${ESPN}/cricket/scoreboard`,
  rugby:       `${ESPN}/rugby/scoreboard`,
};

// Normalise ESPN event → flat format the frontend already uses
function normalise(d) {
  const leagueName = d.leagues?.[0]?.name || d.league?.name || '';
  return (d.events || []).map(e => {
    const comp = e.competitions?.[0] || {};
    const status = comp.status || {};
    const competitors = comp.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home') || competitors[0] || {};
    const away = competitors.find(c => c.homeAway === 'away') || competitors[1] || {};

    const statusText = status.type?.description
      || status.type?.detail
      || status.type?.shortDetail
      || '';

    return {
      strLeague:    comp.league?.name || leagueName,
      dateEvent:    e.date ? new Date(e.date).toLocaleDateString('en-GB') : '',
      strHomeTeam:  home.team?.displayName || '',
      strAwayTeam:  away.team?.displayName || '',
      intHomeScore: home.score != null ? home.score : null,
      intAwayScore: away.score != null ? away.score : null,
      strStatus:    statusText,
      homeLogo:     home.team?.logo || '',
      awayLogo:     away.team?.logo || '',
      strTime:      status.displayClock || '',
      strPeriod:    status.period ? `Period ${status.period}` : '',
    };
  });
}

// GET /api/sports/:type
router.get('/:type', async (req, res) => {
  const type = req.params.type;
  const url  = ENDPOINTS[type] || ENDPOINTS.livescores;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.json({ events: [] });
    const d  = await r.json();
    res.json({ events: normalise(d) });
  } catch (e) {
    console.error('Sports error:', e.message);
    res.json({ events: [] });
  }
});

module.exports = router;
