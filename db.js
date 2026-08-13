const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.connect()
  .then(() => console.log('✅ Neon DB connected'))
  .catch(err => console.error('❌ DB error:', err.message));

pool.on('connect', (client) => {
  client.query('SET search_path TO public');
});
pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
});

module.exports = pool;
