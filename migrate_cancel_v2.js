const pool = require('./db');

async function migrate() {
  try {
    await pool.query(`
      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS cancelled_items_snapshot JSONB,
        ADD COLUMN IF NOT EXISTS refund_history JSONB DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS cancel_type VARCHAR(50) DEFAULT 'refund';
    `);
    console.log('✅ cancel_v2 columns added');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
}

migrate();
