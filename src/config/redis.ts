import Redis from "ioredis";

// Two separate Redis configurations are needed:
//
// 1. redisClient — general purpose client for Lua scripts, GET/SET, pipelines.
//    Uses maxRetriesPerRequest: 3 so failed commands retry a few times.
//
// 2. bullMQRedisOptions — raw options object (NOT a Redis instance) passed to
//    BullMQ Queue and Worker constructors. BullMQ REQUIRES maxRetriesPerRequest
//    to be null because it internally uses blocking commands (BLPOP/BRPOP).
//    If you pass a client with maxRetriesPerRequest set to a number, BullMQ
//    throws: "Your redis options maxRetriesPerRequest must be null."
//    BullMQ creates and manages its own internal connections from this config.

const baseOptions = {
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
};

// ── General client ────────────────────────────────────────────────────────────
export const redisClient = new Redis({
  ...baseOptions,
  maxRetriesPerRequest: 3,
  retryStrategy: (times: number) => Math.min(times * 100, 3000),
});

redisClient.on("connect", () => console.log("[Redis] Connected"));
redisClient.on("error", (err) => console.error("[Redis] Error:", err.message));

// ── BullMQ connection options — maxRetriesPerRequest MUST be null ─────────────
export const bullMQRedisOptions = {
  ...baseOptions,
  maxRetriesPerRequest: null as null,
};

// ─── Key Helpers ───────────────────────────────────────────────────────────────
export const RedisKeys = {
  available:   (eventId: string) => `ticket:${eventId}:available`,
  issuedCount: (eventId: string) => `ticket:${eventId}:issued_count`,
};