const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigins = [
  'http://localhost:5173',
  'https://jewels-teal.vercel.app',
  'https://jewels-teal.vercel.app/',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, origin);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

// Stripe webhook — raw body required, must be before express.json() routes
const Stripe = require('stripe');
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(400).send('Webhook secret not configured');
  let event;
  try {
    event = Stripe(process.env.STRIPE_SECRET_KEY).webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed' || event.type === 'payment_link.completed') {
    const session = event.data.object;
    const pool = require('./db');
    try {
      // Match by payment_link_url stored on order
      const paymentLink = session.payment_link;
      if (paymentLink) {
        const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
        const link = await stripe.paymentLinks.retrieve(paymentLink);
        const linkUrl = link.url;
        await pool.query(
          `UPDATE orders SET balance_due=0, payment_link_url=NULL,
            edit_history = edit_history || $1::jsonb
           WHERE payment_link_url ILIKE $2`,
          [JSON.stringify([{ timestamp: new Date().toISOString(), note: 'Balance paid via Stripe payment link', amount: session.amount_total / 100 }]), `%${paymentLink}%`]
        );
      }
    } catch (err) {
      console.error('Webhook DB update failed:', err.message);
    }
  }
  res.json({ received: true });
});

const path = require('path');

app.use('/api/general', require('./routes/general'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/admin/upload', require('./routes/upload'));

app.use((req, res) => res.status(404).json({ error: 'API route not found' }));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

module.exports = app;
