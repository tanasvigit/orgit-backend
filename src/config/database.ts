import { Pool, PoolConfig } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const poolConfig: PoolConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'orgit',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS || '30000', 10),
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '30000', 10),
  keepAlive: true,
  keepAliveInitialDelayMillis: parseInt(process.env.DB_KEEPALIVE_DELAY_MS || '10000', 10),
};

// Log connection info without exposing credentials
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction) {
  console.log(`[Database] Connecting to database: ${poolConfig.database} on ${poolConfig.host}:${poolConfig.port}`);
} else {
  console.log(`[Database] Connecting to ${poolConfig.database} on ${poolConfig.host}:${poolConfig.port} as ${poolConfig.user}`);
}

const pool = new Pool(poolConfig);

// Test connection and log success
pool.connect((err, _client, release) => {
  if (err) {
    console.error('❌ Error connecting to the database:', err.message);
  } else {
    console.log('✅ Database connected successfully');
    if (release) release();
  }
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

export const query = async (text: string, params?: any[]) => {
  try {
    const res = await pool.query(text, params);
    // Uncomment for query performance monitoring:
    // const duration = Date.now() - start;
    // console.log('Executed query', { text, duration, rows: res.rowCount });
    return res;
  } catch (error) {
    console.error('Database query error', { text, error });
    throw error;
  }
};

export const getClient = async () => {
  const client = await pool.connect();
  const query = client.query.bind(client);
  // Store release method for later use
  client.release = client.release.bind(client);

  // Override client.query to log queries if needed
  client.query = ((...args: any[]) => {
    return (query as any)(...args);
  }) as any;

  return client;
};

export default pool;

