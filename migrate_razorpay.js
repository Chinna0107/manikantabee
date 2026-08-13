require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function migrate() {
  try {
    console.log('Connecting to database...');
    // Rename stripe_payment_intent_id to razorpay_order_id
    await pool.query(`
      ALTER TABLE orders 
      RENAME COLUMN stripe_payment_intent_id TO razorpay_order_id;
    `);
    console.log('Renamed stripe_payment_intent_id to razorpay_order_id');

    // Add new columns
    await pool.query(`
      ALTER TABLE orders 
      ADD COLUMN IF NOT EXISTS razorpay_payment_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS razorpay_signature VARCHAR(255);
    `);
    console.log('Added razorpay_payment_id and razorpay_signature columns');

  } catch (error) {
    if (error.code === '42703' && error.message.includes('stripe_payment_intent_id')) {
      console.log('Column stripe_payment_intent_id already renamed or does not exist, skipping rename.');
    } else {
      console.error('Migration failed:', error);
    }
  } finally {
    pool.end();
  }
}

migrate();
