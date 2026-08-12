const router = require('express').Router();
const pool = require('../db');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { sendOrderEmailToAdmin } = require('../utils/email');

// GET /api/general/db-test
router.get('/db-test', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ time: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/general/categories
router.get('/categories', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM categories ORDER BY id ASC');
    res.json({ categories: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/general/products
router.get('/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products WHERE is_active = true ORDER BY id DESC');
    res.json({ products: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/general/products/:id/reviews
router.post('/products/:id/reviews', async (req, res) => {
  const { name, rating, comment, color, size } = req.body;
  if (!name || !rating || !comment) {
    return res.status(400).json({ error: 'Name, rating, and comment are required' });
  }
  
  try {
    const productRes = await pool.query('SELECT reviews FROM products WHERE id = $1', [req.params.id]);
    if (productRes.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    let currentReviews = productRes.rows[0].reviews || [];
    if (typeof currentReviews === 'string') {
      try { currentReviews = JSON.parse(currentReviews); } catch(e) { currentReviews = []; }
    }
    
    const newReview = {
      name,
      rating: Number(rating),
      comment,
      color: color || null,
      size: size || null,
      date: new Date().toISOString()
    };
    
    currentReviews.push(newReview);
    
    await pool.query(
      'UPDATE products SET reviews = $1 WHERE id = $2',
      [JSON.stringify(currentReviews), req.params.id]
    );
    
    res.json({ success: true, review: newReview });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit review' });
  }
});

// POST /api/general/check-stock
router.post('/check-stock', async (req, res) => {
  const { items } = req.body;
  if (!items || items.length === 0) return res.status(400).json({ error: 'No items' });
  try {
    const unavailable = [];
    for (const item of items) {
      const productId = item.product?.id || item.id;
      if (!productId) continue;
      const prodRes = await pool.query('SELECT name, variants, stock FROM products WHERE id=$1', [productId]);
      if (!prodRes.rows.length) { unavailable.push({ name: item.product?.name || item.name || 'Unknown', reason: 'Product not found', available: 0, requested: item.qty || 1 }); continue; }
      
      const prodName = prodRes.rows[0].name;
      const prodStock = parseInt(prodRes.rows[0].stock || 0);
      let variants = [];
      try { variants = typeof prodRes.rows[0].variants === 'string' ? JSON.parse(prodRes.rows[0].variants) : (prodRes.rows[0].variants || []); } catch(e) {}
      
      const itemColor = (item.variant?.color || item.product?.color || item.color || '').toString().toLowerCase().trim();
      const itemSize = (item.variant?.size || item.size || '').toString().trim();
      let found = false;
      let matchedStock = 0;

      if (Array.isArray(variants) && variants.length > 0) {
        for (const v of variants) {
          const vColor = (v.color || '').toString().toLowerCase().trim();
          const colorMatch = !itemColor || !vColor || vColor === itemColor;
          if (colorMatch) {
            for (const s of (v.sizes || [])) {
              if (!itemSize || s.size?.toString().trim() === itemSize) {
                found = true;
                matchedStock = parseInt(s.stock ?? 0);
                if (matchedStock < parseInt(item.qty || 1)) {
                  unavailable.push({ name: prodName, available: matchedStock, requested: item.qty || 1 });
                }
                break;
              }
            }
          }
          if (found) break;
        }
      }

      if (!found) {
        // Fallback to product-level stock if no variant matched or variants array was empty
        matchedStock = prodStock;
        if (matchedStock < parseInt(item.qty || 1)) {
          unavailable.push({ name: prodName, available: matchedStock, requested: item.qty || 1 });
        }
      }
    }
    res.json({ available: unavailable.length === 0, unavailable });
  } catch (err) {
    console.error('Error in check-stock:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/general/orders (Checkout)
router.post('/orders', async (req, res) => {
  const { items, address, total, coupon_code, payment_method, advance_paid, order_type, stripe_payment_intent_id, discount_amount, shipping_fee, tax_amount } = req.body;
  
  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'Cart is empty' });
  }

  try {
    // Stock validation
    for (const item of items) {
      if (!item.product?.id) continue;
      const prodRes = await pool.query('SELECT name, variants FROM products WHERE id=$1', [item.product.id]);
      if (!prodRes.rows.length) return res.status(400).json({ error: `Product not found` });
      let variants = [];
      try { variants = typeof prodRes.rows[0].variants === 'string' ? JSON.parse(prodRes.rows[0].variants) : (prodRes.rows[0].variants || []); } catch(e) {}
      const itemColor = (item.variant?.color || item.product?.color || '').toString().toLowerCase().trim();
      const itemSize = (item.variant?.size || '').toString().trim();
      for (const v of variants) {
        const colorMatch = !itemColor || !v.color || v.color.toLowerCase().trim() === itemColor;
        if (colorMatch) {
          for (const s of (v.sizes || [])) {
            if (!itemSize || s.size?.toString().trim() === itemSize) {
              if (parseInt(s.stock || 0) < parseInt(item.qty || 1)) {
                return res.status(400).json({ error: `"${prodRes.rows[0].name}" is out of stock or insufficient quantity available.`, outOfStock: true });
              }
            }
          }
        }
      }
    }

    const countRes = await pool.query(`SELECT COUNT(*) FROM orders`);
    const nextNum = parseInt(countRes.rows[0].count) + 1;
    const orderNumber = `HJ-${String(nextNum).padStart(6, '0')}`;
    const itemsJson = JSON.stringify(items);
    const addressJson = JSON.stringify(address || {});
    const pMethod = payment_method || 'prepaid';
    const advancePaid = pMethod === 'cod' ? 100 : (parseFloat(total) || 0);
    const oType = order_type === 'pickup' ? 'pickup' : 'shipping';
    
    const result = await pool.query(
      `INSERT INTO orders (order_number, total, items, address, status, payment_method, advance_paid, order_type, stripe_payment_intent_id, discount_amount, coupon_code, shipping_fee, tax_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [orderNumber, total, itemsJson, addressJson, 'pending', pMethod, advancePaid, oType, stripe_payment_intent_id || null, discount_amount || 0, coupon_code || null, shipping_fee || 0, tax_amount || 0]
    );
    
    // Reduce Stock Logic
    for (const item of items) {
      if (item.product && item.product.id) {
        const prodRes = await pool.query('SELECT variants FROM products WHERE id=$1', [item.product.id]);
        let variants = [];
        try { variants = typeof prodRes.rows[0]?.variants === 'string' ? JSON.parse(prodRes.rows[0].variants) : (prodRes.rows[0]?.variants || []); } catch(e){}

        let updated = false;
        const itemColor = (item.variant?.color || item.product?.color || '').toString().toLowerCase().trim();
        const itemSize = (item.variant?.size || '').toString().trim();

        for (let v of variants) {
          const vColor = (v.color || '').toString().toLowerCase().trim();
          const colorMatch = !itemColor || !vColor || vColor === itemColor;
          if (colorMatch) {
            for (let s of (v.sizes || [])) {
              const sSize = (s.size || '').toString().trim();
              if (!itemSize || sSize === itemSize) {
                s.stock = Math.max(0, parseInt(s.stock || 0) - parseInt(item.qty || 1));
                updated = true;
              }
            }
          }
        }

        if (updated) {
          await pool.query('UPDATE products SET variants=$1 WHERE id=$2', [JSON.stringify(variants), item.product.id]);
        }
      }
    }

    // Mark coupon as used for one_time coupons (only for logged-in users)
    if (coupon_code) {
      const couponRes = await pool.query('SELECT * FROM coupons WHERE code=$1', [coupon_code]);
      const coupon = couponRes.rows[0];
      if (coupon && coupon.usage_type === 'one_time' && result.rows[0].user_id) {
        await pool.query(
          'UPDATE coupons SET used_by = array_append(COALESCE(used_by, \'{}\'), $1::int) WHERE id=$2',
          [result.rows[0].user_id, coupon.id]
        );
      }
    }

    // Send email to admin
    sendOrderEmailToAdmin(orderNumber, total, address, items);
    
    res.json({ success: true, order: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to place order' });
  }
});

// POST /api/general/stripe/create-payment-intent
router.post('/stripe/create-payment-intent', async (req, res) => {
  const { amount } = req.body;
  if (!amount) return res.status(400).json({ error: 'Amount is required' });
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // cents
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
    });
    res.json({ success: true, clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/general/stripe/verify
router.post('/stripe/verify', async (req, res) => {
  const { paymentIntentId } = req.body;
  if (!paymentIntentId) return res.status(400).json({ error: 'paymentIntentId required' });
  try {
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (intent.status === 'succeeded') {
      res.json({ success: true });
    } else {
      res.status(400).json({ error: `Payment not completed. Status: ${intent.status}` });
    }
  } catch (err) {
    console.error('Stripe verify error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/general/banners
router.get('/banners', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM banners WHERE is_active = true ORDER BY created_at DESC');
    res.json({ banners: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/general/validate-coupon
router.post('/validate-coupon', async (req, res) => {
  const { code, cartValue, cartQty, user_id, cartItems } = req.body;
  try {
    const result = await pool.query('SELECT * FROM coupons WHERE code=$1 AND is_active=true', [code]);
    const coupon = result.rows[0];

    if (!coupon) return res.status(404).json({ error: 'Invalid or inactive coupon code' });

    if (coupon.user_id && String(coupon.user_id) !== String(user_id)) {
      return res.status(403).json({ error: 'This coupon is not valid for your account' });
    }

    if (coupon.expires_at && new Date() > new Date(coupon.expires_at)) {
      return res.status(400).json({ error: 'Coupon has expired' });
    }

    // One-time usage check
    if (coupon.usage_type === 'one_time') {
      if (!user_id) return res.status(400).json({ error: 'Please login to use this coupon' });
      const usedBy = (coupon.used_by || []).map(Number);
      if (usedBy.includes(parseInt(user_id))) {
        return res.status(400).json({ error: 'You have already used this coupon' });
      }
    }

    let checkQty = cartQty || 0;
    let checkValue = cartValue || 0;

    const hasCatTarget = coupon.applicable_categories && coupon.applicable_categories.length > 0;
    const hasCodeTarget = coupon.applicable_product_codes && coupon.applicable_product_codes.length > 0;

    if ((hasCatTarget || hasCodeTarget) && cartItems && Array.isArray(cartItems)) {
      let eligibleQty = 0;
      let eligibleValue = 0;

      for (const item of cartItems) {
        let isEligible = false;
        if (hasCatTarget && coupon.applicable_categories.includes(item.category)) {
          isEligible = true;
        }
        if (hasCodeTarget && coupon.applicable_product_codes.includes(item.code)) {
          isEligible = true;
        }
        
        if (isEligible) {
          eligibleQty += (item.qty || 1);
          const currentPrice = item.our_price && item.our_price > 0 ? item.our_price : item.mrp;
          eligibleValue += (currentPrice * (item.qty || 1));
        }
      }

      if (eligibleQty === 0) {
        return res.status(400).json({ error: 'No items in your cart are eligible for this coupon' });
      }

      checkQty = eligibleQty;
      checkValue = eligibleValue;
    }

    // Min requirement check
    if (coupon.min_type === 'qty') {
      if (checkQty < (coupon.min_qty || 0)) {
        return res.status(400).json({ error: `Minimum ${coupon.min_qty} eligible item(s) required` });
      }
    } else {
      if (checkValue < (coupon.min_order_value || 0)) {
        return res.status(400).json({ error: `Minimum eligible order value is $${coupon.min_order_value}` });
      }
    }

    res.json({ success: true, coupon });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/general/offers
router.get('/offers', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM offers WHERE is_active=true ORDER BY created_at DESC');
    res.json({ offers: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/general/shipping
router.get('/shipping', async (req, res) => {
  try {
    const [settingsRes, pincodesRes] = await Promise.all([
      pool.query('SELECT value FROM settings WHERE key = $1', ['shipping']),
      pool.query('SELECT pincode, percentage FROM shipping_pincodes ORDER BY pincode ASC')
    ]);
    const settings = settingsRes.rows[0]?.value || { flat_rate: 0, tax_mode: 'flat', tax_percentage: 0, shipping_rate: 0, pickup_enabled: false };
    res.json({
      settings,
      zipCodes: pincodesRes.rows,
      pincodes: pincodesRes.rows,
      shipping_rate: parseFloat(settings.shipping_rate || settings.flat_rate) || 0,
      tax_percentage: parseFloat(settings.tax_percentage) || 0,
      pickup_enabled: settings.pickup_enabled ?? false
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/general/order/:orderNumber
router.get('/order/:orderNumber', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, order_number, status, order_type, created_at, total, items FROM orders WHERE order_number=$1',
      [req.params.orderNumber]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = result.rows[0];
    if (typeof order.items === 'string') {
      try { order.items = JSON.parse(order.items); } catch(e) { order.items = []; }
    }
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/general/validate-address
router.post('/validate-address', async (req, res) => {
  const { name, street1, street2, city, state, zip, country, phone } = req.body;
  if (!street1 || !city || !zip || !country)
    return res.status(400).json({ valid: false, message: 'Missing required address fields' });
  try {
    const { Shippo } = require('shippo');
    const shippo = process.env.SHIPPO_API_KEY ? new Shippo({ apiKeyHeader: process.env.SHIPPO_API_KEY }) : null;
    if (!shippo) return res.json({ valid: true, message: 'Address validation skipped (Shippo not configured)' });
    const result = await shippo.addresses.create({
      name: name || 'Customer',
      street1,
      street2: street2 || '',
      city,
      state: state || '',
      zip,
      country,
      phone: phone || '',
      validate: true
    });
    const isValid = result.validationResults?.isValid !== false;
    const messages = result.validationResults?.messages || [];
    const errMsg = messages.find(m => m.type === 'error' || m.type === 'warning')?.text || '';
    res.json({ valid: isValid, message: isValid ? 'Address validated' : (errMsg || 'Address could not be validated') });
  } catch (err) {
    console.error('Address validation error:', err.message);
    // Don't block checkout on validation errors
    res.json({ valid: true, message: 'Address validation skipped' });
  }
});

// GET /api/general/reviews
router.get('/reviews', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM reviews WHERE is_active=true ORDER BY created_at DESC');
    res.json({ reviews: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});
// GET /api/general/settings/vacation
router.get('/settings/vacation', async (req, res) => {
  try {
    const result = await pool.query('SELECT value FROM settings WHERE key=$1', ['vacation']);
    res.json(result.rows[0]?.value || { is_active: false, message: '' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/general/settings/announcement
router.get('/settings/announcement', async (req, res) => {
  try {
    const result = await pool.query('SELECT value FROM settings WHERE key = $1', ['announcement_bar']);
    if (result.rows.length > 0) {
      res.json({ announcement: result.rows[0].value });
    } else {
      res.json({ announcement: { text: '', is_active: false, link: '' } });
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
