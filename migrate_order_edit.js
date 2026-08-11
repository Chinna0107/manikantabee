const pool = require('./db');

async function migrate() {
  try {
    await pool.query(`
      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS edit_history JSONB DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS balance_due NUMERIC(10,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS payment_link_url TEXT;
    `);
    console.log('✅ edit_history, balance_due, payment_link_url columns added');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
}

migrate();
