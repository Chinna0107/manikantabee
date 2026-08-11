const pool = require('./db');

async function migrate() {
  try {
    await pool.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;

      -- Backfill: existing verified users get both set to true
      UPDATE users SET phone_verified = TRUE, email_verified = TRUE WHERE is_verified = TRUE;
    `);
    console.log('✅ phone_verified + email_verified columns added');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
}

migrate();
