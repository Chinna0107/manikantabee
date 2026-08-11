const router = require('express').Router();
const pool = require('../db');
const { authMiddleware } = require('./auth');
const { Shippo } = require('shippo');
const shippoClient = process.env.SHIPPO_API_KEY ? new Shippo({ apiKeyHeader: process.env.SHIPPO_API_KEY }) : null;

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access only' });
  next();
}

// GET /api/admin/dashboard/stats
router.get('/dashboard/stats', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [users, orders, revenue] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users WHERE role=$1', ['user']),
      pool.query('SELECT COUNT(*) FROM orders'),
      pool.query("SELECT COALESCE(SUM(total),0) as total FROM orders WHERE status != 'cancelled'"),
    ]);
    res.json({
      totalUsers: parseInt(users.rows[0].count),
      totalOrders: parseInt(orders.rows[0].count),
      totalRevenue: parseFloat(revenue.rows[0].total),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/users
router.get('/users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, phone, role, is_verified, phone_verified, email_verified, created_at FROM users ORDER BY created_at DESC'
    );
    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/users/:id — anonymize so they can re-register with same email/phone
router.delete('/users/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const userRes = await pool.query('SELECT role FROM users WHERE id=$1', [req.params.id]);
    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });
    if (userRes.rows[0].role === 'admin') return res.status(403).json({ error: 'Cannot delete admin' });
    const ghost = `deleted_${req.params.id}_${Date.now()}`;
    await pool.query(
      `UPDATE users SET
        name='[Deleted]', email=$1, phone=NULL,
        password_hash='', is_verified=FALSE,
        phone_verified=FALSE, email_verified=FALSE
       WHERE id=$2`,
      [`${ghost}@deleted.invalid`, req.params.id]
    );
    await pool.query('DELETE FROM otps WHERE email IN (SELECT email FROM users WHERE id=$1)', [req.params.id]);
    res.json({ message: 'User cleared — they can re-register with the same email/phone' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/orders
router.get('/orders', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, u.name as user_name, u.email as user_email
       FROM orders o LEFT JOIN users u ON o.user_id = u.id
       ORDER BY o.created_at DESC`
    );
    res.json({ orders: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/orders/:id/status
router.put('/orders/:id/status', authMiddleware, adminOnly, async (req, res) => {
  const { status } = req.body;
  try {
    const result = await pool.query(
      'UPDATE orders SET status=$1 WHERE id=$2 RETURNING *',
      [status, req.params.id]
    );
    res.json({ order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/orders/:id/refund
const Stripe = require('stripe');
const { sendRefundEmail } = require('../utils/email');
router.post('/orders/:id/refund', authMiddleware, adminOnly, async (req, res) => {
  // cancel_type: 'refund' | 'no_refund' | 'coupon_cancel'
  // cancelled_items: [{ productId, variantSize, cancelQty, price, name, color, size }]
  // refund_breakdown: { items, shipping, tax, transaction_charge, total }
  const { refund_breakdown, cancelled_items, cancel_type = 'refund' } = req.body;
  try {
    const orderRes = await pool.query(
      `SELECT o.*, u.email as user_email FROM orders o LEFT JOIN users u ON o.user_id = u.id WHERE o.id=$1`,
      [req.params.id]
    );
    const order = orderRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'cancelled' && !cancelled_items?.length) return res.status(400).json({ error: 'Order is already cancelled' });

    const isNoRefund = cancel_type === 'no_refund' || cancel_type === 'coupon_cancel';
    const refundAmount = isNoRefund ? 0 : (parseFloat(refund_breakdown?.total) || 0);
    const transactionCharge = parseFloat(refund_breakdown?.transaction_charge) || 0;

    if (!isNoRefund && refundAmount <= 0) return res.status(400).json({ error: 'Refund amount must be greater than 0' });

    // Stripe refund (only for refund type)
    let refundId = null;
    if (!isNoRefund) {
      if (order.stripe_payment_intent_id) {
        const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
        const refund = await stripe.refunds.create({
          payment_intent: order.stripe_payment_intent_id,
          amount: Math.round(refundAmount * 100),
        });
        refundId = refund.id;
      } else {
        refundId = `MANUAL-${Date.now()}`;
      }
    } else {
      refundId = `NO-REFUND-${Date.now()}`;
    }

    let currentItems = [];
    try { currentItems = typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []); } catch(e) {}

    const isPartial = cancelled_items && cancelled_items.length > 0;

    // Build history entry
    let existingHistory = [];
    try { existingHistory = typeof order.refund_history === 'string' ? JSON.parse(order.refund_history) : (order.refund_history || []); } catch(e) {}
    const historyEntry = {
      refund_id: refundId,
      cancel_type,
      amount: refundAmount,
      transaction_charge: transactionCharge,
      breakdown: refund_breakdown || {},
      cancelled_items: cancelled_items || null,
      timestamp: new Date().toISOString(),
    };
    const newHistory = [...existingHistory, historyEntry];

    if (isPartial) {
      // Partial: reduce qty or remove items
      const remainingItems = [];
      const snapshotCancelled = [];

      for (const item of currentItems) {
        const match = cancelled_items.find(ci =>
          ci.productId === item.product?.id &&
          (ci.variantSize || '') === (item.variant?.size || '')
        );
        if (match) {
          const cancelQty = parseInt(match.cancelQty) || item.qty;
          const leftQty = item.qty - cancelQty;
          snapshotCancelled.push({ ...item, qty: cancelQty });
          // Restore stock
          if (item.product?.id) {
            const prodRes = await pool.query('SELECT variants FROM products WHERE id=$1', [item.product.id]);
            let variants = [];
            try { variants = typeof prodRes.rows[0]?.variants === 'string' ? JSON.parse(prodRes.rows[0].variants) : (prodRes.rows[0]?.variants || []); } catch(e) {}
            for (let v of variants) {
              for (let s of (v.sizes || [])) {
                if (!item.variant?.size || s.size?.toString().trim() === item.variant.size) {
                  s.stock = parseInt(s.stock || 0) + cancelQty;
                }
              }
            }
            if (variants.length) await pool.query('UPDATE products SET variants=$1 WHERE id=$2', [JSON.stringify(variants), item.product.id]);
          }
          if (leftQty > 0) remainingItems.push({ ...item, qty: leftQty });
        } else {
          remainingItems.push(item);
        }
      }

      // Merge with existing cancelled snapshot
      let existingSnapshot = [];
      try { existingSnapshot = typeof order.cancelled_items_snapshot === 'string' ? JSON.parse(order.cancelled_items_snapshot) : (order.cancelled_items_snapshot || []); } catch(e) {}
      const fullSnapshot = [...existingSnapshot, ...snapshotCancelled];

      const newTotal = remainingItems.reduce((sum, item) => sum + (item.variant?.price || item.product?.price || 0) * item.qty, 0);
      const newStatus = remainingItems.length === 0 ? 'cancelled' : order.status;
      const newCancelType = remainingItems.length === 0 ? cancel_type : (order.cancel_type || cancel_type);

      await pool.query(
        `UPDATE orders SET items=$1, total=$2, status=$3, refund_id=$4,
          refund_amount=COALESCE(refund_amount,0)+$5, refund_breakdown=$6,
          cancelled_items_snapshot=$7, refund_history=$8, cancel_type=$9 WHERE id=$10`,
        [JSON.stringify(remainingItems), newTotal, newStatus, refundId,
          refundAmount, JSON.stringify(refund_breakdown || {}),
          JSON.stringify(fullSnapshot), JSON.stringify(newHistory), newCancelType, req.params.id]
      );

      await sendRefundEmail({
        order: { ...order, user_email: order.user_email },
        refundId, refundAmount, cancelType: cancel_type,
        cancelledItems: cancelled_items, remainingItems, transactionCharge,
      });

      return res.json({
        success: true, refund_id: refundId, amount: refundAmount,
        partial: true, remaining_items: remainingItems.length,
        cancelled_items_snapshot: fullSnapshot,
      });
    } else {
      // Full cancellation
      for (const item of currentItems) {
        if (!item.product?.id) continue;
        const prodRes = await pool.query('SELECT variants FROM products WHERE id=$1', [item.product.id]);
        let variants = [];
        try { variants = typeof prodRes.rows[0]?.variants === 'string' ? JSON.parse(prodRes.rows[0].variants) : (prodRes.rows[0]?.variants || []); } catch(e) {}
        for (let v of variants) {
          for (let s of (v.sizes || [])) {
            if (!item.variant?.size || s.size?.toString().trim() === item.variant.size) {
              s.stock = parseInt(s.stock || 0) + parseInt(item.qty || 1);
            }
          }
        }
        if (variants.length) await pool.query('UPDATE products SET variants=$1 WHERE id=$2', [JSON.stringify(variants), item.product.id]);
      }

      await pool.query(
        `UPDATE orders SET status='cancelled', refund_id=$1, refund_amount=$2, refund_breakdown=$3,
          cancelled_items_snapshot=$4, refund_history=$5, cancel_type=$6 WHERE id=$7`,
        [refundId, refundAmount, JSON.stringify(refund_breakdown || {}),
          JSON.stringify(currentItems), JSON.stringify(newHistory), cancel_type, req.params.id]
      );

      await sendRefundEmail({
        order: { ...order, user_email: order.user_email },
        refundId, refundAmount, cancelType: cancel_type,
        cancelledItems: null, remainingItems: [], transactionCharge,
      });

      return res.json({ success: true, refund_id: refundId, amount: refundAmount, partial: false, cancel_type });
    }
  } catch (err) {
    console.error('Refund error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/orders/:id/mark-balance-paid
// body: { method: 'cash' | 'upi' | 'stripe' | 'other', note }
router.post('/orders/:id/mark-balance-paid', authMiddleware, adminOnly, async (req, res) => {
  const { method = 'manual', note } = req.body;
  try {
    const orderRes = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    const order = orderRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const balanceDue = parseFloat(order.balance_due) || 0;
    if (balanceDue <= 0) return res.status(400).json({ error: 'No balance due on this order' });

    let existingHistory = [];
    try { existingHistory = typeof order.edit_history === 'string' ? JSON.parse(order.edit_history) : (order.edit_history || []); } catch(e) {}
    const entry = {
      timestamp: new Date().toISOString(),
      note: note || `Balance of $${balanceDue.toFixed(2)} marked as paid (${method})`,
      amount_paid: balanceDue,
      method,
    };

    await pool.query(
      `UPDATE orders SET balance_due=0, payment_link_url=NULL, edit_history=$1 WHERE id=$2`,
      [JSON.stringify([...existingHistory, entry]), req.params.id]
    );
    res.json({ success: true, amount_paid: balanceDue });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/orders/:id/resend-payment-link
// Regenerates a fresh Stripe payment link for the current balance_due
router.post('/orders/:id/resend-payment-link', authMiddleware, adminOnly, async (req, res) => {
  try {
    const orderRes = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    const order = orderRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const balanceDue = parseFloat(order.balance_due) || 0;
    if (balanceDue <= 0) return res.status(400).json({ error: 'No balance due on this order' });

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.paymentLinks.create({
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `Balance due for Order #${order.order_number || order.id}` },
          unit_amount: Math.round(balanceDue * 100),
        },
        quantity: 1,
      }],
      after_completion: { type: 'redirect', redirect: { url: process.env.FRONTEND_URL || 'https://hourajewels.com' } },
    });

    await pool.query('UPDATE orders SET payment_link_url=$1 WHERE id=$2', [session.url, req.params.id]);
    res.json({ success: true, payment_link_url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/orders/:id/edit
// body: { items, address, customer_phone, note }
// - items: full new items array (already-resolved product/variant objects)
// - address: updated shipping address object
// - customer_phone: update user phone
// - note: reason for edit
router.put('/orders/:id/edit', authMiddleware, adminOnly, async (req, res) => {
  const { items: newItems, address, customer_phone, note } = req.body;
  try {
    const orderRes = await pool.query(
      `SELECT o.*, u.email as user_email, u.id as uid FROM orders o LEFT JOIN users u ON o.user_id = u.id WHERE o.id=$1`,
      [req.params.id]
    );
    const order = orderRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'cancelled') return res.status(400).json({ error: 'Cannot edit a cancelled order' });

    let oldItems = [];
    try { oldItems = typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []); } catch(e) {}
    let oldAddress = {};
    try { oldAddress = typeof order.address === 'string' ? JSON.parse(order.address) : (order.address || {}); } catch(e) {}

    const updatedItems = newItems || oldItems;
    const updatedAddress = address ? { ...oldAddress, ...address } : oldAddress;

    // Recalculate total from new items
    const newItemsTotal = updatedItems.reduce((s, i) => s + (i.variant?.price || i.product?.price || 0) * (i.qty || 1), 0);
    const shipping = parseFloat(order.shipping_fee) || 0;
    const tax = parseFloat(order.tax_amount) || 0;
    const discount = parseFloat(order.discount_amount) || 0;
    const newTotal = Math.max(0, newItemsTotal + shipping + tax - discount);
    const oldTotal = parseFloat(order.total) || 0;
    const diff = parseFloat((newTotal - oldTotal).toFixed(2));

    // Restore stock for removed/reduced items, deduct for added/increased
    for (const oldItem of oldItems) {
      if (!oldItem.product?.id) continue;
      const match = updatedItems.find(ni =>
        ni.product?.id === oldItem.product.id &&
        (ni.variant?.size || '') === (oldItem.variant?.size || '')
      );
      const oldQty = oldItem.qty || 1;
      const newQty = match ? (match.qty || 1) : 0;
      const qtyDiff = oldQty - newQty; // positive = restore stock
      if (qtyDiff === 0) continue;
      const prodRes = await pool.query('SELECT variants FROM products WHERE id=$1', [oldItem.product.id]);
      let variants = [];
      try { variants = typeof prodRes.rows[0]?.variants === 'string' ? JSON.parse(prodRes.rows[0].variants) : (prodRes.rows[0]?.variants || []); } catch(e) {}
      for (let v of variants) {
        for (let s of (v.sizes || [])) {
          if (!oldItem.variant?.size || s.size?.toString().trim() === oldItem.variant.size) {
            s.stock = Math.max(0, parseInt(s.stock || 0) + qtyDiff);
          }
        }
      }
      if (variants.length) await pool.query('UPDATE products SET variants=$1 WHERE id=$2', [JSON.stringify(variants), oldItem.product.id]);
    }
    // Deduct stock for newly added items
    for (const newItem of updatedItems) {
      if (!newItem.product?.id) continue;
      const wasInOld = oldItems.find(oi =>
        oi.product?.id === newItem.product.id &&
        (oi.variant?.size || '') === (newItem.variant?.size || '')
      );
      if (!wasInOld) {
        const prodRes = await pool.query('SELECT variants FROM products WHERE id=$1', [newItem.product.id]);
        let variants = [];
        try { variants = typeof prodRes.rows[0]?.variants === 'string' ? JSON.parse(prodRes.rows[0].variants) : (prodRes.rows[0]?.variants || []); } catch(e) {}
        for (let v of variants) {
          for (let s of (v.sizes || [])) {
            if (!newItem.variant?.size || s.size?.toString().trim() === newItem.variant.size) {
              s.stock = Math.max(0, parseInt(s.stock || 0) - (newItem.qty || 1));
            }
          }
        }
        if (variants.length) await pool.query('UPDATE products SET variants=$1 WHERE id=$2', [JSON.stringify(variants), newItem.product.id]);
      }
    }

    // Update customer phone if provided
    if (customer_phone && order.uid) {
      await pool.query('UPDATE users SET phone=$1 WHERE id=$2', [customer_phone, order.uid]);
    }

    // Build edit history entry
    let existingHistory = [];
    try { existingHistory = typeof order.edit_history === 'string' ? JSON.parse(order.edit_history) : (order.edit_history || []); } catch(e) {}
    const historyEntry = {
      timestamp: new Date().toISOString(),
      note: note || 'Order edited by admin',
      old_total: oldTotal,
      new_total: newTotal,
      diff,
      old_items: oldItems,
      new_items: updatedItems,
      old_address: oldAddress,
      new_address: updatedAddress,
      old_phone: oldAddress.mobile,
      new_phone: customer_phone || oldAddress.mobile,
    };
    const newHistory = [...existingHistory, historyEntry];

    let paymentLinkUrl = null;
    let balanceDue = 0;
    let refundId = null;
    let refundAmount = 0;

    if (diff > 0) {
      // Customer owes more — create Stripe payment link
      balanceDue = diff;
      const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
      const session = await stripe.paymentLinks.create({
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: { name: `Balance due for Order #${order.order_number || order.id}` },
            unit_amount: Math.round(diff * 100),
          },
          quantity: 1,
        }],
        after_completion: { type: 'redirect', redirect: { url: process.env.FRONTEND_URL || 'https://hourajewels.com' } },
      });
      paymentLinkUrl = session.url;
    } else if (diff < 0) {
      // Refund the difference
      refundAmount = Math.abs(diff);
      if (order.stripe_payment_intent_id) {
        const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
        const refund = await stripe.refunds.create({
          payment_intent: order.stripe_payment_intent_id,
          amount: Math.round(refundAmount * 100),
        });
        refundId = refund.id;
      } else {
        refundId = `MANUAL-EDIT-${Date.now()}`;
      }
    }

    await pool.query(
      `UPDATE orders SET
        items=$1, address=$2, total=$3,
        edit_history=$4,
        balance_due=$5,
        payment_link_url=$6,
        refund_id=COALESCE($7, refund_id),
        refund_amount=COALESCE(refund_amount,0)+$8
       WHERE id=$9`,
      [
        JSON.stringify(updatedItems),
        JSON.stringify(updatedAddress),
        newTotal,
        JSON.stringify(newHistory),
        balanceDue,
        paymentLinkUrl,
        refundId,
        refundAmount,
        req.params.id,
      ]
    );

    res.json({
      success: true,
      new_total: newTotal,
      diff,
      balance_due: balanceDue,
      payment_link_url: paymentLinkUrl,
      refund_id: refundId,
      refund_amount: refundAmount,
    });
  } catch (err) {
    console.error('Order edit error:', err);
    res.status(500).json({ error: err.message });
  }
});

const shiprocket = require('../utils/shiprocket');

// POST /api/admin/orders/:id/ship
router.post('/orders/:id/ship', authMiddleware, adminOnly, async (req, res) => {
  try {
    const orderRes = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    const order = orderRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });

    let items = [];
    try { items = typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []); } catch(e) {}

    // Calculate total weight from item sizes, fallback to 16oz
    let totalWeightOz = 0;
    for (const item of items) {
      const w = parseFloat(item.variant?.weight || item.size?.weight || 0);
      totalWeightOz += (w > 0 ? w : 16) * (item.qty || 1);
    }
    if (totalWeightOz === 0) totalWeightOz = 16;

    let address = {};
    try { address = typeof order.address === 'string' ? JSON.parse(order.address) : (order.address || {}); } catch(e) {}

    const orderItems = items.map(item => ({
      name: item.product?.name || 'Product',
      sku: item.variant?.size || 'Default',
      units: item.qty || 1,
      selling_price: item.variant?.price || item.product?.price || 0,
    }));

    const totalWeight = items.reduce((sum, item) => {
      const w = parseFloat(item.variant?.weight || item.size?.weight || 0);
      return sum + (w > 0 ? w : 0.5) * (item.qty || 1);
    }, 0) || 0.5;

    const shiprocketPayload = {
      order_id: order.order_number || order.id.toString(),
      order_date: new Date(order.created_at).toISOString().split('T')[0],
      billing_customer_name: address.name || 'Customer',
      billing_last_name: '',
      billing_address: address.line1 || 'No Address',
      billing_city: address.city || 'City',
      billing_pincode: address.pincode || '110001',
      billing_state: address.state || 'State',
      billing_country: 'India',
      billing_email: order.user_email || 'test@test.com',
      billing_phone: order.user_phone || address.mobile || '9999999999',
      shipping_is_billing: true,
      order_items: orderItems,
      payment_method: order.payment_method === 'cod' ? 'COD' : 'Prepaid',
      sub_total: order.payment_method === 'cod' ? (order.total - (order.advance_paid || 0)) : order.total,
      length: 10,
      breadth: 10,
      height: 10,
      weight: totalWeight
    };

    // 1. Create Custom Order in Shiprocket
    const srOrder = await shiprocket.createCustomOrder(shiprocketPayload);
    const shipmentId = srOrder.shipment_id || srOrder.payload?.shipment_id;
    if (!shipmentId) throw new Error('Shiprocket did not return a shipment_id');

    // 2. Generate AWB
    const awbRes = await shiprocket.assignAWB(shipmentId);
    const awbCode = awbRes.response?.data?.awb_code || awbRes.awb_code;

    // 3. Save to database
    await pool.query(
      'UPDATE orders SET tracking_id=$1, tracking_link=$2, status=$3 WHERE id=$4',
      [awbCode, `https://shiprocket.co/tracking/${awbCode}`, 'shipped', req.params.id]
    );

    res.json({ awb: awbCode, tracking_link: `https://shiprocket.co/tracking/${awbCode}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/orders/:id/shippo-rates
router.post('/orders/:id/shippo-rates', authMiddleware, adminOnly, async (req, res) => {
  if (!shippoClient) return res.status(500).json({ error: 'Shippo is not configured in backend' });

  try {
    const orderRes = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    const order = orderRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });

    let items = [];
    try { items = typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []); } catch(e) {}

    let totalWeightOz = 0;
    for (const item of items) {
      const w = parseFloat(item.variant?.weight || item.size?.weight || 0);
      totalWeightOz += (w > 0 ? w : 16) * (item.qty || 1);
    }
    if (totalWeightOz === 0) totalWeightOz = 16;

    let address = {};
    try { address = typeof order.address === 'string' ? JSON.parse(order.address) : (order.address || {}); } catch(e) {}

    const addressFrom = {
      name: 'Houra Jewels',
      street1: '123 Main St',
      city: 'San Francisco',
      state: 'CA',
      zip: '94117',
      country: 'US',
      phone: '+1 555 341 9393',
      email: 'admin@hourajewels.com',
    };

    const addressTo = {
      name: address.name || 'Customer',
      street1: address.line1 || 'No Address',
      street2: address.line2 || '',
      city: address.city || 'City',
      state: address.state || '',
      zip: address.pincode || '00000',
      country: address.country || 'US',
      phone: address.mobile || '0000000000',
    };

    const parcel = {
      length: '5',
      width: '5',
      height: '5',
      distanceUnit: 'in',
      weight: totalWeightOz.toString(),
      massUnit: 'oz',
    };

    const shipmentPayload = {
      addressFrom: addressFrom,
      addressTo: addressTo,
      parcels: [parcel],
      async: false
    };

    if (addressFrom.country !== addressTo.country) {
      shipmentPayload.customsDeclaration = {
        contentsType: 'MERCHANDISE',
        nonDeliveryOption: 'RETURN',
        certify: true,
        certifySigner: 'Houra Jewels',
        eelPfc: 'NOEEI_30_37_a',
        items: [{
          description: 'Jewelry',
          quantity: 1,
          netWeight: '16',
          massUnit: 'oz',
          valueAmount: (order.total || 10).toString(),
          valueCurrency: 'USD',
          originCountry: addressFrom.country
        }]
      };
    }

    const shipment = await shippoClient.shipments.create(shipmentPayload);

    const rates = shipment.rates;
    if (!rates || rates.length === 0) {
      return res.status(400).json({ error: 'No shipping rates found for this address.' });
    }
    res.json({ rates });
  } catch (err) {
    console.error('Shippo error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/orders/:id/shippo-label
router.post('/orders/:id/shippo-label', authMiddleware, adminOnly, async (req, res) => {
  if (!shippoClient) return res.status(500).json({ error: 'Shippo is not configured in backend' });

  const { rateObjectId } = req.body;
  if (!rateObjectId) return res.status(400).json({ error: 'rateObjectId is required' });

  try {
    const transaction = await shippoClient.transactions.create({
      rate: rateObjectId,
      labelFileType: 'PDF',
      async: false
    });

    if (transaction.status !== 'SUCCESS') {
      const msgs = transaction.messages ? transaction.messages.map(m => m.text || m).join(', ') : 'Unknown error';
      return res.status(400).json({ error: `Failed to purchase label: ${msgs}` });
    }

    const trackingNumber = transaction.trackingNumber;
    const trackingUrl = transaction.trackingUrlProvider;
    const labelUrl = transaction.labelUrl;

    await pool.query(
      `UPDATE orders SET 
        tracking_number=$1, 
        tracking_url=$2, 
        shipping_label_url=$3, 
        tracking_id=$4,
        tracking_link=$5,
        status='shipped' 
       WHERE id=$6`,
      [trackingNumber, trackingUrl, labelUrl, trackingNumber, trackingUrl, req.params.id]
    );

    res.json({ 
      success: true, 
      tracking_number: trackingNumber,
      tracking_url: trackingUrl,
      label_url: labelUrl
    });
  } catch (err) {
    console.error('Shippo error:', err);
    res.status(500).json({ error: err.message });
  }
});


// --- Products ---
router.get('/products', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY created_at DESC');
    res.json({ products: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/products', authMiddleware, adminOnly, async (req, res) => {
    const { name, description, stock, sizes, image_url, images, color, category, model, is_active, is_bestseller, is_trending, is_offer, is_festive, variants, reviews, details, allow_reviews } = req.body;
    
    if ((!sizes || !Array.isArray(sizes) || sizes.length === 0) && (!variants || !Array.isArray(variants) || variants.length === 0)) {
      return res.status(400).json({ error: 'At least one size or variant with price is required.' });
    }

    try {
      if (variants && variants.length > 0) {
        const allProdsRes = await pool.query('SELECT id, variants FROM products');
        const existingCodes = new Set();
        for (const row of allProdsRes.rows) {
          let v = [];
          try { v = typeof row.variants === 'string' ? JSON.parse(row.variants) : (row.variants || []); } catch(e) {}
          v.forEach(va => va.sizes?.forEach(s => { if (s.code) existingCodes.add(s.code.trim().toLowerCase()); }));
        }
        
        for (const v of variants) {
          for (const s of (v.sizes || [])) {
            if (!s.code || !s.code.trim()) {
              return res.status(400).json({ error: 'All variant sizes must have a valid product code.' });
            }
            if (existingCodes.has(s.code.trim().toLowerCase())) {
              return res.status(400).json({ error: `Product code "${s.code}" already exists.` });
            }
            s.stock = parseInt(s.stock_delta || s.stock || 0); // initial setup
            delete s.stock_delta;
          }
        }
      }
    const result = await pool.query(
      `INSERT INTO products 
       (name, description, stock, sizes, image_url, images, color, category, model, is_active, is_bestseller, is_trending, is_offer, is_festive, variants, reviews, details, allow_reviews) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING *`,
      [
        name, description, stock, JSON.stringify(sizes || []), image_url, 
        JSON.stringify(images || []), color, category, model, 
        is_active ?? true,
        is_bestseller ?? false,
        is_trending ?? false,
        is_offer ?? false,
        is_festive ?? false,
        JSON.stringify(variants || []),
        JSON.stringify(reviews || []),
        JSON.stringify(details || []),
        allow_reviews ?? true
      ]
    );
    res.json({ product: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/products/:id', authMiddleware, adminOnly, async (req, res) => {
  const { name, description, sizes, stock, image_url, images, color, category, model, is_active, is_bestseller, is_trending, is_offer, is_festive, variants, reviews, details, allow_reviews } = req.body;
  try {
    if (variants && variants.length > 0) {
      const allProdsRes = await pool.query('SELECT id, variants FROM products WHERE id != $1', [req.params.id]);
      const existingCodes = new Set();
      for (const row of allProdsRes.rows) {
        let v = [];
        try { v = typeof row.variants === 'string' ? JSON.parse(row.variants) : (row.variants || []); } catch(e) {}
        v.forEach(va => va.sizes?.forEach(s => { if (s.code) existingCodes.add(s.code.trim().toLowerCase()); }));
      }

      // Fetch current product to process stock_delta
      const currProdRes = await pool.query('SELECT variants FROM products WHERE id = $1', [req.params.id]);
      let currVariants = [];
      try { currVariants = typeof currProdRes.rows[0].variants === 'string' ? JSON.parse(currProdRes.rows[0].variants) : (currProdRes.rows[0].variants || []); } catch(e) {}
      
      for (const v of variants) {
        for (const s of (v.sizes || [])) {
          if (!s.code || !s.code.trim()) {
            return res.status(400).json({ error: 'All variant sizes must have a valid product code.' });
          }
          if (existingCodes.has(s.code.trim().toLowerCase())) {
            return res.status(400).json({ error: `Product code "${s.code}" already exists.` });
          }
          
          // Apply stock_delta if provided
          if (s.stock_delta !== undefined && s.stock_delta !== null && s.stock_delta !== '') {
            let existingStock = 0;
            // Find this size in existing variants to get its current stock
            for (const cv of currVariants) {
              const cs = (cv.sizes || []).find(x => x.code === s.code);
              if (cs) {
                existingStock = parseInt(cs.stock || 0);
                break;
              }
            }
            const delta = parseInt(s.stock_delta || 0);
            const newStock = existingStock + delta;
            if (newStock < 0) {
              return res.status(400).json({ error: `Insufficient stock to reduce ${Math.abs(delta)} from "${s.code}". Currently only ${existingStock} available.` });
            }
            s.stock = newStock;
            delete s.stock_delta; // clean up before saving
          } else {
            // New size added without delta, or no delta passed
            s.stock = parseInt(s.stock || 0);
          }
        }
      }
    }

    const sizesJson = Array.isArray(sizes) ? JSON.stringify(sizes) : '[]';
    const imagesJson = Array.isArray(images) ? JSON.stringify(images) : (image_url ? JSON.stringify([image_url]) : '[]');
    const variantsJson = Array.isArray(variants) ? JSON.stringify(variants) : '[]';
    const reviewsJson = Array.isArray(reviews) ? JSON.stringify(reviews) : '[]';
    const detailsJson = Array.isArray(details) ? JSON.stringify(details) : '[]';
    const result = await pool.query(
      'UPDATE products SET name=$1, description=$2, sizes=$3, stock=$4, image_url=$5, images=$6, color=$7, category=$8, model=$9, is_active=$10, is_bestseller=$11, is_trending=$12, is_offer=$13, is_festive=$14, variants=$15, reviews=$16, details=$17, allow_reviews=$18 WHERE id=$19 RETURNING *',
      [name, description, sizesJson, stock, image_url, imagesJson, color, category, model || null, is_active, is_bestseller, is_trending, is_offer, is_festive, variantsJson, reviewsJson, detailsJson, allow_reviews ?? true, req.params.id]
    );
    res.json({ product: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/products/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
    res.json({ message: 'Product deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Banners ---
router.get('/banners', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM banners ORDER BY created_at DESC');
    res.json({ banners: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/banners', authMiddleware, adminOnly, async (req, res) => {
  const { title, image_url, link_url, is_active } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO banners (title, image_url, link_url, is_active) VALUES ($1, $2, $3, $4) RETURNING *',
      [title, image_url, link_url, is_active ?? true]
    );
    res.json({ banner: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/banners/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM banners WHERE id=$1', [req.params.id]);
    res.json({ message: 'Banner deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Coupons ---
router.get('/coupons', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT c.*, u.name as user_name FROM coupons c LEFT JOIN users u ON c.user_id = u.id ORDER BY c.created_at DESC');
    res.json({ coupons: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/coupons', authMiddleware, adminOnly, async (req, res) => {
  const { code, discount_type, discount_value, min_order_value, is_active, expires_at, user_id, usage_type, min_type, min_qty, applicable_categories, applicable_product_codes } = req.body;
  try {
    const finalUserId = user_id === 'all' ? null : user_id;
    const finalExpires = expires_at ? new Date(expires_at) : null;
    const finalCategories = JSON.stringify(applicable_categories || []);
    const finalCodes = JSON.stringify(applicable_product_codes || []);
    
    const result = await pool.query(
      'INSERT INTO coupons (code, discount_type, discount_value, min_order_value, is_active, expires_at, user_id, usage_type, min_type, min_qty, applicable_categories, applicable_product_codes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
      [code, discount_type, discount_value, min_order_value || 0, is_active, finalExpires, finalUserId, usage_type || 'multiple', min_type || 'amount', min_qty || 0, finalCategories, finalCodes]
    );
    res.json({ coupon: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/coupons/:id', authMiddleware, adminOnly, async (req, res) => {
  const { code, discount_type, discount_value, min_order_value, is_active, expires_at, user_id, usage_type, min_type, min_qty, applicable_categories, applicable_product_codes } = req.body;
  try {
    const finalUserId = user_id === 'all' ? null : user_id;
    const finalExpires = expires_at ? new Date(expires_at) : null;
    const finalCategories = JSON.stringify(applicable_categories || []);
    const finalCodes = JSON.stringify(applicable_product_codes || []);
    
    const result = await pool.query(
      'UPDATE coupons SET code=$1, discount_type=$2, discount_value=$3, min_order_value=$4, is_active=$5, expires_at=$6, user_id=$7, usage_type=$8, min_type=$9, min_qty=$10, applicable_categories=$11, applicable_product_codes=$12 WHERE id=$13 RETURNING *',
      [code, discount_type, discount_value, min_order_value || 0, is_active, finalExpires, finalUserId, usage_type || 'multiple', min_type || 'amount', min_qty || 0, finalCategories, finalCodes, req.params.id]
    );
    res.json({ coupon: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/coupons/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM coupons WHERE id=$1', [req.params.id]);
    res.json({ message: 'Coupon deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CATEGORIES ---

// GET /api/admin/categories
router.get('/categories', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM categories ORDER BY id ASC');
    res.json({ categories: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/categories
router.post('/categories', authMiddleware, adminOnly, async (req, res) => {
  const { name, models, image_url } = req.body;
  try {
    const modelsJson = Array.isArray(models) ? JSON.stringify(models) : '[]';
    const result = await pool.query(
      'INSERT INTO categories (name, models, image_url) VALUES ($1, $2, $3) RETURNING *',
      [name, modelsJson, image_url]
    );
    res.json({ category: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/admin/categories/:id
router.put('/categories/:id', authMiddleware, adminOnly, async (req, res) => {
  const { name, models, image_url } = req.body;
  try {
    const modelsJson = Array.isArray(models) ? JSON.stringify(models) : '[]';
    const result = await pool.query(
      'UPDATE categories SET name=$1, models=$2, image_url=$3 WHERE id=$4 RETURNING *',
      [name, modelsJson, image_url, req.params.id]
    );
    res.json({ category: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/admin/categories/:id
router.delete('/categories/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM categories WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});
// ================== OFFERS ==================

// GET /api/admin/offers
router.get('/offers', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM offers ORDER BY created_at DESC');
    res.json({ offers: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/offers
router.post('/offers', authMiddleware, adminOnly, async (req, res) => {
  const { title, discount_percentage, is_active } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO offers (title, discount_percentage, is_active) VALUES ($1, $2, $3) RETURNING *',
      [title, discount_percentage, is_active ?? true]
    );
    res.json({ offer: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/admin/offers/:id
router.put('/offers/:id', authMiddleware, adminOnly, async (req, res) => {
  const { title, discount_percentage, is_active } = req.body;
  try {
    const result = await pool.query(
      'UPDATE offers SET title=$1, discount_percentage=$2, is_active=$3 WHERE id=$4 RETURNING *',
      [title, discount_percentage, is_active, req.params.id]
    );
    res.json({ offer: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/admin/offers/:id
router.delete('/offers/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM offers WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/offers/:id/apply
router.post('/offers/:id/apply', authMiddleware, adminOnly, async (req, res) => {
  const { category, productIds } = req.body;
  try {
    if (category) {
      await pool.query('UPDATE products SET offer_id=$1 WHERE category=$2', [req.params.id, category]);
    } else if (productIds && productIds.length > 0) {
      await pool.query('UPDATE products SET offer_id=$1 WHERE id = ANY($2)', [req.params.id, productIds]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});
// GET /api/admin/settings/shipping
router.get('/settings/shipping', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT value FROM settings WHERE key = $1', ['shipping']);
    const settings = result.rows[0]?.value || { flat_rate: 0, tax_mode: 'flat', tax_percentage: 0 };
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/settings/shipping
router.post('/settings/shipping', authMiddleware, adminOnly, async (req, res) => {
  try {
    const existing = await pool.query('SELECT value FROM settings WHERE key = $1', ['shipping']);
    const current = existing.rows[0]?.value || {};
    const merged = { ...current, ...req.body };
    if (merged.flat_rate !== undefined) merged.flat_rate = parseFloat(merged.flat_rate) || 0;
    if (merged.tax_percentage !== undefined) merged.tax_percentage = parseFloat(merged.tax_percentage) || 0;
    if (merged.tax_mode !== undefined) merged.tax_mode = merged.tax_mode === 'pincode' ? 'pincode' : 'flat';
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()',
      ['shipping', JSON.stringify(merged)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/shipping-pincodes
router.get('/shipping-pincodes', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM shipping_pincodes ORDER BY created_at DESC');
    res.json({ pincodes: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/shipping-pincodes
router.post('/shipping-pincodes', authMiddleware, adminOnly, async (req, res) => {
  const { pincode, percentage } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO shipping_pincodes (pincode, percentage) VALUES ($1, $2) RETURNING *',
      [pincode, percentage]
    );
    res.json({ pincode: result.rows[0] });
  } catch (err) {
    // 23505 is unique violation
    if (err.code === '23505') return res.status(400).json({ error: 'Pincode already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/admin/shipping-pincodes/:id
router.delete('/shipping-pincodes/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM shipping_pincodes WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/settings/announcement
router.get('/settings/announcement', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT value FROM settings WHERE key = $1', ['announcement_bar']);
    if (result.rows.length > 0) {
      res.json({ announcement: result.rows[0].value });
    } else {
      res.json({ announcement: { text: '', is_active: false, link: '' } });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/settings/announcement
router.post('/settings/announcement', authMiddleware, adminOnly, async (req, res) => {
  const { text, is_active, link, items } = req.body;
  try {
    const value = JSON.stringify({ text, is_active, link, items: items || [] });
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('announcement_bar', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [value]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- REVIEWS ---

// GET /api/admin/reviews
router.get('/reviews', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM reviews ORDER BY created_at DESC');
    res.json({ reviews: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/reviews
router.post('/reviews', authMiddleware, adminOnly, async (req, res) => {
  const { name, rating, review, is_active } = req.body;
  if (!name || !review) return res.status(400).json({ error: 'Name and review are required' });
  try {
    const result = await pool.query(
      'INSERT INTO reviews (name, rating, review, is_active) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, rating || 5, review, is_active ?? true]
    );
    res.json({ review: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/reviews/:id
router.put('/reviews/:id', authMiddleware, adminOnly, async (req, res) => {
  const { name, rating, review, is_active } = req.body;
  try {
    const result = await pool.query(
      'UPDATE reviews SET name=$1, rating=$2, review=$3, is_active=$4 WHERE id=$5 RETURNING *',
      [name, rating || 5, review, is_active ?? true, req.params.id]
    );
    res.json({ review: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/reviews/:id
router.delete('/reviews/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM reviews WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/settings/shipping-rate
router.post('/settings/shipping-rate', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { shipping_rate } = req.body;
    const existing = await pool.query('SELECT value FROM settings WHERE key=$1', ['shipping']);
    const current = existing.rows[0]?.value || {};
    const merged = { ...current, shipping_rate: parseFloat(shipping_rate) || 0 };
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()',
      ['shipping', JSON.stringify(merged)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/settings/tax
router.post('/settings/tax', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { tax_percentage } = req.body;
    const existing = await pool.query('SELECT value FROM settings WHERE key=$1', ['shipping']);
    const current = existing.rows[0]?.value || {};
    const merged = { ...current, tax_percentage: parseFloat(tax_percentage) || 0 };
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()',
      ['shipping', JSON.stringify(merged)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/settings/vacation
router.get('/settings/vacation', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT value FROM settings WHERE key=$1', ['vacation']);
    res.json(result.rows[0]?.value || { is_active: false, message: '' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/settings/vacation
router.post('/settings/vacation', authMiddleware, adminOnly, async (req, res) => {
  const { is_active, message } = req.body;
  try {
    const value = JSON.stringify({ is_active: !!is_active, message: message || '' });
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('vacation', $1) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [value]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
