import Redis from "ioredis";

// ioredis automatically reconnects on drop — critical for production.
// We export two separate instances:
//   - redisClient  → general reads/writes
//   - redisSubscriber → dedicated connection for Lua scripts / blocking ops
// (A single Redis connection cannot be shared between regular commands and
//  pub/sub or blocking commands simultaneously.)

const redisOptions = {
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
  maxRetriesPerRequest: 3,
  retryStrategy: (times: number) => Math.min(times * 100, 3000),
};

export const redisClient = new Redis(redisOptions);

redisClient.on("connect", () => console.log("[Redis] Connected"));
redisClient.on("error", (err) => console.error("[Redis] Error:", err.message));

// ─── Key Helpers ───────────────────────────────────────────────────────────────
// Centralising key names avoids typo bugs scattered across files.

export const RedisKeys = {
  available: (eventId: string) => `ticket:${eventId}:available`,
  issuedCount: (eventId: string) => `ticket:${eventId}:issued_count`,
};