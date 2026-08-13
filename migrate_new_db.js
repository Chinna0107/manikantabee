const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { execSync } = require('child_process');

const oldUrl = 'postgresql://neondb_owner:npg_GTLZ56YiQavr@ep-old-recipe-aykljlu9-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
const newUrl = 'postgresql://neondb_owner:npg_u7gN9RxkJMiH@ep-wispy-dawn-ay9qw8ef-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

async function migrate() {
  console.log('🚀 Starting Database Migration...');

  // 1. Fetch tables from Old DB first using a temporary pool connection
  const tempOldPool = new Pool({ connectionString: oldUrl, ssl: { rejectUnauthorized: false } });
  const tablesRes = await tempOldPool.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  const tables = tablesRes.rows.map(r => r.table_name);
  await tempOldPool.end();

  // 2. Restore Schema from Old DB to New DB
  console.log('📦 Exporting schema from Old DB and restoring to New DB...');
  const dumpSchemaCmd = `/opt/homebrew/bin/pg_dump --dbname="${oldUrl}" --schema-only --no-owner --no-acl --if-exists --clean | /opt/homebrew/bin/psql --dbname="${newUrl}"`;
  execSync(dumpSchemaCmd, { stdio: 'inherit' });
  console.log('✅ Schema restored successfully.');

  // 3. Restore data for non-product tables in dependency order
  const dataTables = [
    'users',
    'categories',
    'offers',
    'banners',
    'settings',
    'shipping_pincodes',
    'otps',
    'coupons',
    'addresses',
    'orders',
    'reviews'
  ];

  console.log('📦 Exporting data for non-product tables in order:', dataTables);

  for (const table of dataTables) {
    const dumpTableDataCmd = `/opt/homebrew/bin/pg_dump --dbname="${oldUrl}" --data-only --table="public.${table}" --no-owner --no-acl | /opt/homebrew/bin/psql --dbname="${newUrl}"`;
    try {
      execSync(dumpTableDataCmd, { stdio: 'inherit' });
      console.log(`  ✅ Restored data for table: ${table}`);
    } catch (e) {
      console.error(`  ❌ Error restoring table ${table}:`, e.message);
    }
  }

  // 4. Connect newPool NOW after schema and tables exist
  const newPool = new Pool({ connectionString: newUrl, ssl: { rejectUnauthorized: false } });

  // Truncate products table to ensure 0 rows as requested
  console.log('🧹 Truncating products table (no products needed)...');
  await newPool.query('TRUNCATE TABLE products CASCADE;');
  console.log('✅ Products table cleared (0 rows).');

  // 5. Seed admin user admin@manikanta.com
  console.log('👤 Seeding admin user admin@manikanta.com...');
  const adminEmail = 'admin@manikanta.com';
  const adminPass = await bcrypt.hash('Admin@1234', 10);
  await newPool.query(`
    INSERT INTO users (name, email, phone, password_hash, is_verified, role)
    VALUES ('Admin', $1, '+91 00000 00000', $2, TRUE, 'admin')
    ON CONFLICT (email) DO UPDATE SET role='admin', is_verified=TRUE, password_hash=$2
  `, [adminEmail, adminPass]);
  console.log('✅ Admin user seeded.');

  // 6. Reset primary key sequences for all tables
  console.log('🔄 Syncing sequences...');
  for (const table of tables) {
    try {
      await newPool.query(`
        SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 1), true);
      `);
    } catch (e) {
      // ignore tables without id sequence
    }
  }
  console.log('✅ Sequences synced.');

  // 7. Verify final counts
  console.log('\n📊 Migration Summary for New Database:');
  for (const table of tables) {
    const cnt = await newPool.query(`SELECT count(*) FROM "${table}"`);
    console.log(`  ${table}: ${cnt.rows[0].count} rows`);
  }

  const adminCheck = await newPool.query(`SELECT id, email, role, is_verified FROM users WHERE email = $1`, [adminEmail]);
  console.log('\n👤 Admin User Verification:', adminCheck.rows);

  await newPool.end();
  console.log('\n🎉 Migration complete!');
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
