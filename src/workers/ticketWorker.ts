import { Worker, Job } from "bullmq";
import { bullMQRedisOptions } from "../config/redis";
import { ticketRepository } from "../repositories/ticketRepository";
import { TicketPersistJob } from "../types";
import pool from "../config/database";

/**
 * Worker: runs in the background (same process).
 * Picks jobs off the BullMQ queue and persists to PostgreSQL atomically:
 *   1. Bulk-inserts ticket rows into issued_tickets
 *   2. Decrements ticket_pools.available by the purchased quantity
 *
 * Both operations run inside ONE transaction — either both succeed or
 * both roll back. This keeps ticket_pools.available in sync with the
 * actual issued_tickets row count at all times.
 *
 * concurrency: 10 — up to 10 jobs processed simultaneously.
 * Tune to stay within DB pool max (20 in database.ts).
 */
export function startTicketWorker(): Worker<TicketPersistJob> {
  const worker = new Worker<TicketPersistJob>(
    "ticket-persist",
    async (job: Job<TicketPersistJob>) => {
      const { userId, eventId, ticketNumbers } = job.data;
      const quantity = ticketNumbers.length;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // 1. Insert all ticket rows (one round-trip via unnest)
        await ticketRepository.bulkInsertTickets(
          client,
          eventId,
          userId,
          ticketNumbers
        );

        // 2. Decrement available in ticket_pools to keep DB in sync
        //    This is safe here (not a race condition) because Redis is the
        //    source of truth for availability — this is just a bookkeeping
        //    update so the DB reflects what Redis already decremented atomically.
        await ticketRepository.decrementAvailable(client, eventId, quantity);

        await client.query("COMMIT");

        console.log(
          `[Worker] Persisted ${quantity} tickets for user ${userId} / event ${eventId}`
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