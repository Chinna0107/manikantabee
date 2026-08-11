const pool = require('./db');

async function run() {
  try {
    await pool.query(`
      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(100),
        ADD COLUMN IF NOT EXISTS stripe_last4 VARCHAR(4);
    `);
    console.log('Migration complete: discount_amount, coupon_code, stripe_last4 added to orders');
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}
run();
