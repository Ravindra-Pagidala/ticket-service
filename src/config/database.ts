import { Pool } from "pg";

// Single shared connection pool for the entire application.
// pg.Pool manages a pool of reusable connections — creating a new Pool per
// request would exhaust DB connections under load.
const pool = new Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5433),
  database: process.env.DB_NAME ?? "tickets",
  user: process.env.DB_USER ?? "postgres",
  password: process.env.DB_PASSWORD ?? "postgres",
  // How many connections to keep open. Under high concurrency, requests queue
  // here rather than hammering the DB with unlimited connections.
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  console.error("[DB] Unexpected pool error:", err.message);
});

export default pool;