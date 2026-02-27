import { Worker, Job } from "bullmq";
import { redisClient } from "../config/redis";
import { ticketRepository } from "../repositories/ticketRepository";
import pool from "../config/database";
import { TicketPersistJob } from "../types";

/**
 * Worker: runs in the background (same process or separate process).
 * Picks jobs off the queue and persists ticket rows to PostgreSQL.
 *
 * This decouples the HTTP response time from the DB write latency.
 * The user gets a response as soon as Redis confirms reservation —
 * the DB write happens asynchronously here.
 *
 * Concurrency = 10 means this worker processes up to 10 jobs simultaneously.
 * Tune this based on your DB pool size (max: 20 in database.ts).
 */
export function startTicketWorker(): Worker<TicketPersistJob> {
  const worker = new Worker<TicketPersistJob>(
    "ticket-persist",
    async (job: Job<TicketPersistJob>) => {
      const { userId, eventId, ticketNumbers } = job.data;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        await ticketRepository.bulkInsertTickets(
          client,
          eventId,
          userId,
          ticketNumbers
        );

        await client.query("COMMIT");

        console.log(
          `[Worker] Persisted ${ticketNumbers.length} tickets for user ${userId} / event ${eventId}`
        );
      } catch (err) {
        await client.query("ROLLBACK");
        // Re-throwing causes BullMQ to mark job as failed and retry per backoff config
        throw err;
      } finally {
        client.release();
      }
    },
    {
      connection: redisClient,
      concurrency: 10,
    }
  );

  worker.on("completed", (job) => {
    console.log(`[Worker] Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}