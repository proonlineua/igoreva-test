const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle client', err.message);
});

async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    if (process.env.NODE_ENV !== 'production') {
      console.log('[DB]', { query: text.slice(0, 80), duration: Date.now() - start, rows: res.rowCount });
    }
    return res;
  } catch (err) {
    console.error('[DB ERROR]', err.message, '\nQuery:', text.slice(0, 120));
    throw err;
  }
}

module.exports = { pool, query };
