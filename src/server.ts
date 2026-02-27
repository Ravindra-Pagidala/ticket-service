import express from "express";
import { ticketController } from "./controllers/ticketController";
import { globalErrorHandler, notFoundHandler } from "./middleware/errorHandler";
import { ticketService } from "./services/ticketService";
import { startTicketWorker } from "./workers/ticketWorker";
import pool from "./config/database";
import { redisClient } from "./config/redis";

const app = express();
app.use(express.json());

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post("/purchase", (req, res) => ticketController.purchase(req, res));

// Health check — useful for load balancer probes
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── Middleware (must come AFTER routes) ──────────────────────────────────────

app.use(notFoundHandler);
app.use(globalErrorHandler);

// ─── Startup ──────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3000);
const EVENTS_TO_SYNC = [
  "EVENT001",
  "EVENT002",
  "EVENT003",
  "EVENT004",
  "EVENT005",
  "EVENT006",
];

async function waitForDatabase(maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await pool.query("SELECT 1");
      console.log("[DB] Database is ready");
      return;
    } catch {
      console.log(`[DB] Waiting for database... (${i + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("Database connection timeout after max retries");
}

async function waitForRedis(maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    if (redisClient.status === "ready") {
      console.log("[Redis] Redis is ready");
      return;
    }
    console.log(`[Redis] Waiting for Redis... (${i + 1}/${maxRetries})`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Redis is optional — we fall back to DB if unavailable
  console.warn("[Redis] Redis not available — will use DB fallback path");
}

async function syncAllEventsToRedis(): Promise<void> {
  console.log("[Startup] Syncing all events to Redis...");
  await Promise.all(
    EVENTS_TO_SYNC.map((eventId) =>
      ticketService.syncEventToRedis(eventId).catch((err) => {
        console.error(`[Startup] Failed to sync ${eventId}:`, (err as Error).message);
      })
    )
  );
  console.log("[Startup] Redis sync complete");
}

async function bootstrap(): Promise<void> {
  await waitForDatabase();
  await waitForRedis();

  if (redisClient.status === "ready") {
    await syncAllEventsToRedis();
    // Start background worker — processes async DB writes from queue
    startTicketWorker();
    console.log("[Worker] Ticket persistence worker started");
  }

  app.listen(PORT, () => {
    console.log(`[Server] Running on port ${PORT}`);
    console.log(`[Server] Mode: ${redisClient.status === "ready" ? "Redis + Queue (high scale)" : "DB only (fallback)"}`);
  });
}

bootstrap().catch((err) => {
  console.error("[Server] Fatal startup error:", err);
  process.exit(1);
});