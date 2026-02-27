import { Worker, Job } from "bullmq";
import { bullMQRedisOptions } from "../config/redis";
import { ticketRepository } from "../repositories/ticketRepository";
import { TicketPersistJob } from "../types";
import pool from "../config/database";

/**
 * Worker: runs in the background (same process).
 * Picks jobs off the queue and persists ticket rows to PostgreSQL.
 *
 * Decouples HTTP response time from DB write latency — user gets a response
 * as soon as Redis confirms reservation; DB write happens here asynchronously.
 *
 * concurrency: 10 means up to 10 jobs processed simultaneously.
 *
 * NOTE: Uses bullMQRedisOptions (maxRetriesPerRequest: null) — required by BullMQ
 * for Worker because it uses blocking Redis commands (BRPOPLPUSH) internally.
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
      connection: bullMQRedisOptions,
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