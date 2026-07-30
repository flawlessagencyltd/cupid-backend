const { Pool } = require("pg");

// One shared pool per process. Both chat state and analytics use it, so scaling
// replicas cannot accidentally multiply two independent pools in each process.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "0" ? false : { rejectUnauthorized: false },
  max: Math.max(2, +(process.env.PG_POOL_MAX || 8)),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 4000,
  allowExitOnIdle: false,
});

pool.on("error", (error) => console.warn("postgres pool error:", error.message));

module.exports = { pool };
