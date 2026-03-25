const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'orgit',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function createOrgsForAdmins() {
  let client;
  try {
    console.log('Connecting to database...');
    client = await pool.connect();
    console.log('✓ Database connected successfully\n');

    // Find all admins who don't have an organization
    const adminsResult = await client.query(
      `SELECT u.id, u.name, u.mobile, u.role
       FROM users u
       WHERE u.role = 'admin'
       AND NOT EXISTS (
         SELECT 1 FROM user_organizations uo WHERE uo.user_id = u.id
       )
       ORDER BY u.created_at`
    );

    const admins = adminsResult.rows;

    if (admins.length === 0) {
      console.log('✓ All admins already have organizations assigned.');
      return;
    }

    console.log(`Found ${admins.length} admin(s) without organizations:\n`);

    for (const admin of admins) {
      console.log(`Processing: ${admin.name} (${admin.mobile})`);

      // Create organization with admin's name
      const orgResult = await client.query(
        `INSERT INTO organizations (id, name, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING id, name`,
        [admin.name || `Organization of ${admin.name}`]
      );

      const organization = orgResult.rows[0];
      console.log(`  ✓ Created organization: "${organization.name}" (${organization.id})`);

      // Link admin to the organization
      await client.query(
        `INSERT INTO user_organizations (id, user_id, organization_id, created_at)
         VALUES (gen_random_uuid(), $1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, organization_id) DO NOTHING`,
        [admin.id, organization.id]
      );

      console.log(`  ✓ Linked admin to organization\n`);
    }

    console.log(`\n✅ Successfully created organizations for ${admins.length} admin(s).`);
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  } finally {
    if (client) {
      client.release();
    }
    await pool.end();
  }
}

createOrgsForAdmins();

