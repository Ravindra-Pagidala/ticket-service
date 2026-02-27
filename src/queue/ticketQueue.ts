import { Queue } from "bullmq";
import { redisClient } from "../config/redis";
import { TicketPersistJob } from "../types";


/**
 * BullMQ Queue — receives ticket persistence jobs from the service layer
 * and fans them out to the worker process.
 *
 * Why BullMQ?
 * - Built on Redis (no extra infra needed)
 * - Guarantees at-least-once delivery with job acknowledgment
 * - If the worker crashes mid-job, BullMQ retries automatically
 * - Dashboard-friendly (Bull Board) for observability
 */
export const ticketQueue = new Queue<TicketPersistJob>("ticket-persist", {
  connection: redisClient,
  defaultJobOptions: {
    attempts: 5,                      // retry up to 5 times on DB failure
    backoff: { type: "exponential", delay: 500 }, // wait 500ms, 1s, 2s, 4s, 8s
    removeOnComplete: 1000,           // keep last 1000 completed jobs for debugging
    removeOnFail: 500,
  },
});

ticketQueue.on("error", (err) => {
  console.error("[Queue] ticketQueue error:", err.message);
});