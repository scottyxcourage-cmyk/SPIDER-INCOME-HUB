const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { protect } = require('../middleware/auth');

const PLATFORM_COMMISSION = 0.15; // SpiderHub keeps 15% of every sale/rental

// GET /api/marketplace/listings — browse (optional ?category=)
router.get('/listings', protect, async (req, res) => {
  try {
    const { category } = req.query;
    const listings = await db.execute({
      sql: `SELECT l.*, u.username as seller_username, u.avatar as seller_avatar,
                   (SELECT COUNT(*) FROM bot_reviews WHERE listing_id = l.id) as review_count,
                   (SELECT COALESCE(AVG(rating),0) FROM bot_reviews WHERE listing_id = l.id) as rating_avg
            FROM bot_listings l JOIN users u ON u.id = l.seller_id
            WHERE l.status = 'active' ${category ? 'AND l.category = ?' : ''}
            ORDER BY l.sales_count DESC, l.created_at DESC`,
      args: category ? [category] : []
    });
    res.json(listings.rows.map(l => ({ ...l, rating_avg: Math.round(l.rating_avg * 10) / 10 })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/marketplace/my-purchases — bots the user owns or is currently renting, with download access
router.get('/my-purchases', protect, async (req, res) => {
  try {
    const purchases = await db.execute({
      sql: `SELECT p.id, p.type, p.price_paid, p.rented_until, p.created_at,
                   l.id as listing_id, l.name, l.cover_image, l.download_url, l.category
            FROM bot_purchases p JOIN bot_listings l ON l.id = p.listing_id
            WHERE p.buyer_id = ? ORDER BY p.created_at DESC`,
      args: [req.user.id]
    });
    const now = new Date();
    res.json(purchases.rows.map(p => {
      const expired = p.type === 'rent' && p.rented_until && new Date(p.rented_until) < now;
      return { ...p, expired, downloadUrl: expired ? null : p.download_url };
    }));
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/marketplace/my-listings — bots the user is selling
router.get('/my-listings', protect, async (req, res) => {
  try {
    const listings = await db.execute({
      sql: `SELECT l.*, (SELECT COUNT(*) FROM bot_reviews WHERE listing_id = l.id) as review_count,
                   (SELECT COALESCE(AVG(rating),0) FROM bot_reviews WHERE listing_id = l.id) as rating_avg
            FROM bot_listings l WHERE l.seller_id = ? ORDER BY l.created_at DESC`,
      args: [req.user.id]
    });
    res.json(listings.rows.map(l => ({ ...l, rating_avg: Math.round(l.rating_avg * 10) / 10 })));
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/marketplace/listings/:id — detail + reviews
router.get('/listings/:id', protect, async (req, res) => {
  try {
    const l = await db.execute({
      sql: `SELECT l.*, u.username as seller_username, u.avatar as seller_avatar
            FROM bot_listings l JOIN users u ON u.id = l.seller_id WHERE l.id = ?`,
      args: [req.params.id]
    });
    if (l.rows.length === 0) return res.status(404).json({ message: 'Listing not found' });

    const reviews = await db.execute({
      sql: `SELECT r.id, r.rating, r.comment, r.created_at, u.username, u.avatar
            FROM bot_reviews r JOIN users u ON u.id = r.user_id
            WHERE r.listing_id = ? ORDER BY r.created_at DESC LIMIT 30`,
      args: [req.params.id]
    });
    const owned = await db.execute({
      sql: 'SELECT 1 FROM bot_purchases WHERE listing_id = ? AND buyer_id = ?',
      args: [req.params.id, req.user.id]
    });

    const ratingAvg = reviews.rows.length ? reviews.rows.reduce((s, r) => s + r.rating, 0) / reviews.rows.length : 0;
    res.json({ ...l.rows[0], reviews: reviews.rows, ratingAvg: Math.round(ratingAvg * 10) / 10, alreadyOwned: owned.rows.length > 0 });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/marketplace/listings — sell a bot
router.post('/listings', protect, async (req, res) => {
  try {
    const { name, description, category, coverImage, downloadUrl, demoUrl, priceCOPS, rentalPricePerDay } = req.body;
    if (!name || !downloadUrl || !priceCOPS) {
      return res.status(400).json({ message: 'name, downloadUrl, and priceCOPS are required' });
    }
    const id = uuidv4();
    await db.execute({
      sql: `INSERT INTO bot_listings (id, seller_id, name, description, category, cover_image, download_url, demo_url, price_cops, rental_price_cops_per_day)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, req.user.id, name.trim(), description || '', category || 'whatsapp', coverImage || '', downloadUrl, demoUrl || '', parseInt(priceCOPS, 10), parseInt(rentalPricePerDay, 10) || 0]
    });
    res.status(201).json({ id, message: 'Bot listed on the marketplace!' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/marketplace/listings/:id — seller updates their listing (e.g. new download link = "update")
router.put('/listings/:id', protect, async (req, res) => {
  try {
    const l = await db.execute({ sql: 'SELECT seller_id FROM bot_listings WHERE id = ?', args: [req.params.id] });
    if (l.rows.length === 0) return res.status(404).json({ message: 'Listing not found' });
    if (l.rows[0].seller_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ message: 'Not allowed' });

    const { name, description, coverImage, downloadUrl, demoUrl, priceCOPS, rentalPricePerDay, status } = req.body;
    await db.execute({
      sql: `UPDATE bot_listings SET name = COALESCE(?, name), description = COALESCE(?, description),
                                     cover_image = COALESCE(?, cover_image), download_url = COALESCE(?, download_url),
                                     demo_url = COALESCE(?, demo_url), price_cops = COALESCE(?, price_cops),
                                     rental_price_cops_per_day = COALESCE(?, rental_price_cops_per_day),
                                     status = COALESCE(?, status)
            WHERE id = ?`,
      args: [name, description, coverImage, downloadUrl, demoUrl, priceCOPS ? parseInt(priceCOPS, 10) : null,
             rentalPricePerDay != null ? parseInt(rentalPricePerDay, 10) : null, status, req.params.id]
    });
    res.json({ message: 'Listing updated' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/marketplace/listings/:id/buy
router.post('/listings/:id/buy', protect, async (req, res) => {
  try {
    const l = await db.execute({ sql: "SELECT * FROM bot_listings WHERE id = ? AND status = 'active'", args: [req.params.id] });
    if (l.rows.length === 0) return res.status(404).json({ message: 'Listing not found' });
    const listing = l.rows[0];
    if (listing.seller_id === req.user.id) return res.status(400).json({ message: "You can't buy your own bot" });

    const already = await db.execute({ sql: "SELECT 1 FROM bot_purchases WHERE listing_id = ? AND buyer_id = ? AND type = 'buy'", args: [req.params.id, req.user.id] });
    if (already.rows.length > 0) return res.status(400).json({ message: 'You already own this bot' });

    const balRes = await db.execute({ sql: 'SELECT wallet_balance FROM users WHERE id = ?', args: [req.user.id] });
    const balance = balRes.rows[0]?.wallet_balance || 0;
    if (balance < listing.price_cops) return res.status(400).json({ message: 'Insufficient COPS balance' });

    const sellerCut = Math.round(listing.price_cops * (1 - PLATFORM_COMMISSION));

    await db.execute({ sql: 'UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?', args: [listing.price_cops, req.user.id] });
    await db.execute({ sql: 'UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', args: [sellerCut, listing.seller_id] });
    await db.execute({ sql: 'UPDATE bot_listings SET sales_count = sales_count + 1 WHERE id = ?', args: [req.params.id] });

    const purchaseId = uuidv4();
    await db.execute({
      sql: 'INSERT INTO bot_purchases (id, listing_id, buyer_id, type, price_paid) VALUES (?, ?, ?, ?, ?)',
      args: [purchaseId, req.params.id, req.user.id, 'buy', listing.price_cops]
    });
    await db.execute({
      sql: `INSERT INTO wallet_transactions (id, user_id, type, amount, description) VALUES (?, ?, 'spend', ?, ?)`,
      args: [uuidv4(), req.user.id, -listing.price_cops, `Bought bot: ${listing.name}`]
    });
    await db.execute({
      sql: `INSERT INTO wallet_transactions (id, user_id, type, amount, description) VALUES (?, ?, 'sale', ?, ?)`,
      args: [uuidv4(), listing.seller_id, sellerCut, `Sold bot: ${listing.name}`]
    });
    await db.execute({
      sql: `INSERT INTO notifications (id, user_id, title, body, type) VALUES (?, ?, '💰 Bot Sold!', ?, 'success')`,
      args: [uuidv4(), listing.seller_id, `${req.user.username} bought "${listing.name}" — you earned ⚡${sellerCut} COPS.`]
    });

    res.json({ message: 'Purchase successful!', downloadUrl: listing.download_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/marketplace/listings/:id/rent — { days }
router.post('/listings/:id/rent', protect, async (req, res) => {
  try {
    const days = parseInt(req.body.days, 10);
    if (!days || days < 1) return res.status(400).json({ message: 'days is required' });

    const l = await db.execute({ sql: "SELECT * FROM bot_listings WHERE id = ? AND status = 'active'", args: [req.params.id] });
    if (l.rows.length === 0) return res.status(404).json({ message: 'Listing not found' });
    const listing = l.rows[0];
    if (!listing.rental_price_cops_per_day) return res.status(400).json({ message: 'This bot is not available for rent' });
    if (listing.seller_id === req.user.id) return res.status(400).json({ message: "You can't rent your own bot" });

    const totalPrice = listing.rental_price_cops_per_day * days;
    const balRes = await db.execute({ sql: 'SELECT wallet_balance FROM users WHERE id = ?', args: [req.user.id] });
    const balance = balRes.rows[0]?.wallet_balance || 0;
    if (balance < totalPrice) return res.status(400).json({ message: 'Insufficient COPS balance' });

    const sellerCut = Math.round(totalPrice * (1 - PLATFORM_COMMISSION));
    const rentedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    await db.execute({ sql: 'UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?', args: [totalPrice, req.user.id] });
    await db.execute({ sql: 'UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', args: [sellerCut, listing.seller_id] });
    await db.execute({ sql: 'UPDATE bot_listings SET sales_count = sales_count + 1 WHERE id = ?', args: [req.params.id] });

    await db.execute({
      sql: 'INSERT INTO bot_purchases (id, listing_id, buyer_id, type, price_paid, rented_until) VALUES (?, ?, ?, ?, ?, ?)',
      args: [uuidv4(), req.params.id, req.user.id, 'rent', totalPrice, rentedUntil]
    });
    await db.execute({
      sql: `INSERT INTO wallet_transactions (id, user_id, type, amount, description) VALUES (?, ?, 'spend', ?, ?)`,
      args: [uuidv4(), req.user.id, -totalPrice, `Rented bot: ${listing.name} (${days}d)`]
    });
    await db.execute({
      sql: `INSERT INTO wallet_transactions (id, user_id, type, amount, description) VALUES (?, ?, 'sale', ?, ?)`,
      args: [uuidv4(), listing.seller_id, sellerCut, `Bot rental: ${listing.name} (${days}d)`]
    });

    res.json({ message: `Rented for ${days} day(s)!`, downloadUrl: listing.download_url, rentedUntil });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/marketplace/listings/:id/review — only buyers/renters can review
router.post('/listings/:id/review', protect, async (req, res) => {
  try {
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ message: 'rating must be 1-5' });

    const owned = await db.execute({ sql: 'SELECT 1 FROM bot_purchases WHERE listing_id = ? AND buyer_id = ?', args: [req.params.id, req.user.id] });
    if (owned.rows.length === 0) return res.status(403).json({ message: 'You need to buy or rent this bot before reviewing it' });

    const existing = await db.execute({ sql: 'SELECT 1 FROM bot_reviews WHERE listing_id = ? AND user_id = ?', args: [req.params.id, req.user.id] });
    if (existing.rows.length > 0) {
      await db.execute({ sql: 'UPDATE bot_reviews SET rating = ?, comment = ? WHERE listing_id = ? AND user_id = ?', args: [rating, comment || '', req.params.id, req.user.id] });
    } else {
      await db.execute({
        sql: 'INSERT INTO bot_reviews (id, listing_id, user_id, rating, comment) VALUES (?, ?, ?, ?, ?)',
        args: [uuidv4(), req.params.id, req.user.id, rating, comment || '']
      });
    }
    res.json({ message: 'Review submitted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/marketplace/listings/:id
router.delete('/listings/:id', protect, async (req, res) => {
  try {
    const l = await db.execute({ sql: 'SELECT seller_id FROM bot_listings WHERE id = ?', args: [req.params.id] });
    if (l.rows.length === 0) return res.status(404).json({ message: 'Listing not found' });
    if (l.rows[0].seller_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ message: 'Not allowed' });
    await db.execute({ sql: "UPDATE bot_listings SET status = 'removed' WHERE id = ?", args: [req.params.id] });
    res.json({ message: 'Listing removed' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
