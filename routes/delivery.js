const router = require('express').Router();
const pool = require('../db');
const { authMiddleware } = require('./auth');

function deliveryOnly(req, res, next) {
  if (req.user?.role !== 'delivery') return res.status(403).json({ error: 'Delivery access only' });
  next();
}

// GET /api/delivery/orders — Get assigned orders for logged in delivery partner
router.get('/orders', authMiddleware, deliveryOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM orders WHERE delivery_partner_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ orders: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/delivery/orders/:id/deliver — Mark order as delivered
router.post('/orders/:id/deliver', authMiddleware, deliveryOnly, async (req, res) => {
  try {
    const check = await pool.query('SELECT status FROM orders WHERE id=$1 AND delivery_partner_id=$2', [req.params.id, req.user.id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Order not found or not assigned to you' });
    
    const updateResult = await pool.query(
      'UPDATE orders SET status = $1, delivered_at = NOW() WHERE id = $2 RETURNING *',
      ['delivered', req.params.id]
    );
    res.json({ success: true, order: updateResult.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
