const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { protect } = require('../middleware/auth');
const { getEffectivePlan, getNextPlan } = require('../utils/plans');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';

// Daily AI credit limits now come from the user's plan tier (see utils/plans.js)

// System prompts per tool — this is what makes the "AI Center" more than one chatbot
const TOOL_PROMPTS = {
  chat: 'You are SpiderAI, a friendly and helpful assistant created by Scotty for SpiderHub — a digital income and WhatsApp bot platform from Zimbabwe. Help users with WhatsApp bots using Baileys.js, JavaScript, Node.js, deploying on Render/pxxl, making money online, and SpiderHub features. Always respond in English only. Never say you are DeepSeek or any other AI — you are SpiderAI. Be concise, friendly, and practical. Keep responses short and mobile-friendly.',
  writer: 'You are an expert copywriter. Write clear, engaging content based on the user\'s request (blog post, caption, email, ad copy, etc). Match the tone they ask for. Return only the finished content, no meta-commentary.',
  code: 'You are an expert software engineer. Write clean, correct, well-commented code for the user\'s request. Default to JavaScript/Node.js unless another language is specified. Return the code in a markdown code block, with a one-line explanation above it if helpful.',
  website: 'You are a frontend developer. Generate a complete, single-file HTML page (inline CSS and JS) for the user\'s request. Make it modern, mobile-responsive, and visually clean. Return only the HTML in a single markdown code block.',
  logo: 'You are a logo designer. Generate a simple, clean SVG logo concept based on the user\'s description. Return valid, self-contained SVG markup in a markdown code block, plus a one-sentence explanation of the concept.',
  resume: 'You are a professional resume writer. Turn the user\'s input (role, experience, skills) into polished, ATS-friendly resume content. Use clear section headers and bullet points. Return only the resume content.',
  story: 'You are a creative fiction writer. Write an engaging short story or script based on the user\'s prompt. Keep it well-structured with a clear beginning, middle, and end unless they ask for something else.',
  translator: 'You are a professional translator. Translate the user\'s text accurately and naturally, preserving tone and meaning. If they specify a target language, use it; otherwise infer the most likely intended language pair from context. Return only the translation.',
  homework: 'You are a patient, encouraging tutor. Explain the concept or solve the problem step by step so the student actually understands it, not just the final answer. Use simple language and examples.',
};

const TOOLS_WITH_TEXT_OUTPUT = new Set(Object.keys(TOOL_PROMPTS));

async function checkAndConsumeCredit(user) {
  const plan = await getEffectivePlan(user);
  const dailyLimit = plan.aiDailyLimit;

  const today = new Date().toISOString().slice(0, 10);
  const lastDate = user.ai_daily_date ? user.ai_daily_date.slice(0, 10) : null;
  let used = lastDate === today ? (user.ai_daily_used || 0) : 0;

  if (used >= dailyLimit) {
    return { allowed: false, remaining: 0, limit: dailyLimit, plan };
  }

  used += 1;
  await db.execute({
    sql: `UPDATE users SET ai_daily_used = ?, ai_daily_date = datetime('now') WHERE id = ?`,
    args: [used, user.id]
  });
  return { allowed: true, remaining: dailyLimit - used, limit: dailyLimit, plan };
}

// Builds the 429 body shown right at the moment a user hits their daily AI cap —
// includes enough for the frontend to render a direct "upgrade to X for Y/day" prompt.
function upsellPayload(credit) {
  const next = getNextPlan(credit.plan.id);
  return {
    message: next
      ? `Daily AI limit reached (${credit.limit}/day on ${credit.plan.name}). Upgrade to ${next.name} for ${next.aiDailyLimit === 999999 ? 'unlimited' : next.aiDailyLimit + '/day'}.`
      : `Daily AI limit reached (${credit.limit}/day). Try again tomorrow.`,
    upgradeNeeded: !!next,
    currentPlan: credit.plan.id,
    currentLimit: credit.limit,
    nextPlan: next ? { id: next.id, name: next.name, aiDailyLimit: next.aiDailyLimit, priceCOPS: next.priceCOPS } : null
  };
}

async function callOpenRouter(systemPrompt, messages) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': process.env.APP_URL || 'https://spiderhub.example.com',
      'X-Title': 'SpiderHub AI'
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      max_tokens: 1500,
      messages: [{ role: 'system', content: systemPrompt }, ...messages]
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || 'AI API error');
  }
  return data.choices?.[0]?.message?.content || 'No response';
}

// GET /api/ai/credits — how many free generations are left today
router.get('/credits', protect, async (req, res) => {
  const plan = await getEffectivePlan(req.user);
  const today = new Date().toISOString().slice(0, 10);
  const lastDate = req.user.ai_daily_date ? req.user.ai_daily_date.slice(0, 10) : null;
  const used = lastDate === today ? (req.user.ai_daily_used || 0) : 0;
  const remaining = Math.max(0, plan.aiDailyLimit - used);
  const next = getNextPlan(plan.id);
  res.json({
    used, limit: plan.aiDailyLimit, remaining, plan: plan.id,
    nextPlan: next ? { id: next.id, name: next.name, aiDailyLimit: next.aiDailyLimit, priceCOPS: next.priceCOPS } : null
  });
});

// POST /api/ai/chat — original SpiderAI multi-turn chatbot (kept for the AI Chat tab)
router.post('/chat', protect, async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ message: 'messages array is required' });
  }
  try {
    const credit = await checkAndConsumeCredit(req.user);
    if (!credit.allowed) {
      return res.status(429).json(upsellPayload(credit));
    }
    const text = await callOpenRouter(TOOL_PROMPTS.chat, messages);
    res.json({ content: [{ type: 'text', text }], creditsRemaining: credit.remaining });
  } catch (err) {
    console.error('AI chat error:', err);
    res.status(500).json({ message: 'AI service temporarily unavailable' });
  }
});

// POST /api/ai/generate — single-shot generation for the AI Center tools
router.post('/generate', protect, async (req, res) => {
  const { tool, prompt } = req.body;
  if (!tool || !prompt || !prompt.trim()) {
    return res.status(400).json({ message: 'tool and prompt are required' });
  }

  if (tool === 'image') {
    return res.status(501).json({
      message: "AI Image Generator isn't connected to a provider yet — add an image generation API key (e.g. Stability AI, Replicate, OpenAI Images) on the server to enable this tool.",
      needsSetup: true
    });
  }

  if (!TOOLS_WITH_TEXT_OUTPUT.has(tool)) {
    return res.status(400).json({ message: 'Unknown AI tool' });
  }

  try {
    const credit = await checkAndConsumeCredit(req.user);
    if (!credit.allowed) {
      return res.status(429).json(upsellPayload(credit));
    }

    const result = await callOpenRouter(TOOL_PROMPTS[tool], [{ role: 'user', content: prompt }]);

    const id = uuidv4();
    await db.execute({
      sql: 'INSERT INTO ai_generations (id, user_id, tool, prompt, result) VALUES (?, ?, ?, ?, ?)',
      args: [id, req.user.id, tool, prompt, result]
    });

    // Small XP nudge for using AI tools — ties into the gamification layer
    await db.execute({ sql: 'UPDATE users SET xp = xp + 3 WHERE id = ?', args: [req.user.id] });

    res.json({ id, tool, result, creditsRemaining: credit.remaining });
  } catch (err) {
    console.error('AI generate error:', err);
    res.status(500).json({ message: 'AI service temporarily unavailable' });
  }
});

// GET /api/ai/history?tool=writer — user's recent generations, optionally filtered by tool
router.get('/history', protect, async (req, res) => {
  try {
    const { tool } = req.query;
    const rows = tool
      ? await db.execute({
          sql: 'SELECT id, tool, prompt, result, created_at FROM ai_generations WHERE user_id = ? AND tool = ? ORDER BY created_at DESC LIMIT 20',
          args: [req.user.id, tool]
        })
      : await db.execute({
          sql: 'SELECT id, tool, prompt, result, created_at FROM ai_generations WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
          args: [req.user.id]
        });
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
