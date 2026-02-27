import pool from "../config/database";
import { redisClient, RedisKeys } from "../config/redis";
import { ticketQueue } from "../queue/ticketQueue";
import { ticketRepository } from "../repositories/ticketRepository";


// ─── Lua Script ────────────────────────────────────────────────────────────────
//
// Why Lua? Redis executes Lua scripts atomically — it pauses all other
// commands while the script runs. This gives us the same "check then act"
// guarantee that SELECT FOR UPDATE gives us in PostgreSQL, but at Redis
// speed (~0.1ms vs ~5ms for a DB round-trip).
//
// KEYS[1] = available count key  (e.g. "ticket:EVENT001:available")
// KEYS[2] = issued count key     (e.g. "ticket:EVENT001:issued_count")
// ARGV[1] = quantity to reserve
//
// Returns: starting ticket number on success, -1 if not enough tickets, -2 if key missing
const RESERVE_TICKETS_LUA = `
local available = tonumber(redis.call('GET', KEYS[1]))
if available == nil then
  return -2
end
local qty = tonumber(ARGV[1])
if available < qty then
  return -1
end
redis.call('DECRBY', KEYS[1], qty)
local new_issued = redis.call('INCRBY', KEYS[2], qty)
return new_issued - qty + 1
`;

// ─── Service ───────────────────────────────────────────────────────────────────

export class TicketService {
  /**
   * PRIMARY PATH (Bonus / High Scale): Redis Lua Script + Async Queue
   *
   * Flow:
   *   1. Lua script atomically checks availability and reserves tickets in Redis
   *   2. We immediately calculate ticket numbers from the atomic counter
   *   3. We respond to the user instantly (sub-millisecond Redis op)
   *   4. A BullMQ job is queued to persist the rows to PostgreSQL asynchronously
   *
   * This handles tens of thousands of req/sec across multiple server instances
   * because Redis is a single-threaded, sub-millisecond store and Lua scripts
   * are atomic — no two scripts can interleave.
   */
  async purchaseTicketsViaRedis(
    userId: string,
    eventId: string,
    quantity: number
  ): Promise<number[]> {
    const availableKey = RedisKeys.available(eventId);
    const issuedKey = RedisKeys.issuedCount(eventId);

    // Atomic check-and-decrement
    const result = await redisClient.eval(
      RESERVE_TICKETS_LUA,
      2,              // number of KEYS
      availableKey,
      issuedKey,
      String(quantity)
    );

    const startingTicketNumber = Number(result);

    if (startingTicketNumber === -2) {
      throw new Error("Event not found");
    }
    if (startingTicketNumber === -1) {
      throw new Error("Not enough tickets available");
    }

    // Generate ticket numbers from the atomically reserved range
    const ticketNumbers: number[] = [];
    for (let i = 0; i < quantity; i++) {
      ticketNumbers.push(startingTicketNumber + i);
    }

    // Enqueue async DB write — non-blocking, returns immediately
    await ticketQueue.add("persist-tickets", { userId, eventId, ticketNumbers });

    return ticketNumbers;
  }

  /**
   * FALLBACK PATH (Basic Fix): PostgreSQL Transaction + SELECT FOR UPDATE
   *
   * Used when Redis is unavailable. Solves the race condition by wrapping
   * the entire read-check-write sequence in a single transaction where the
   * ticket_pools row is row-locked. Any concurrent request hitting the same
   * event will BLOCK at the SELECT FOR UPDATE until this transaction commits,
   * then read the updated (decremented) value.
   *
   * Tradeoff: serialises purchases per event — fine for moderate load
   * (thousands/sec), but becomes a bottleneck at very high concurrency
   * because all requests queue behind the DB lock.
   */
  async purchaseTicketsViaDB(
    userId: string,
    eventId: string,
    quantity: number
  ): Promise<number[]> {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // ROW-LEVEL LOCK: concurrent transactions block here until we COMMIT
      const ticketPool = await ticketRepository.lockAndGetPool(client, eventId);

      if (!ticketPool) {
        throw new Error("Event not found");
      }

      if (ticketPool.available < quantity) {
        throw new Error("Not enough tickets available");
      }

      // Safe to calculate — we hold the lock, no other transaction can
      // change 'available' between this line and the UPDATE below
      const startingTicketNumber = ticketPool.total - ticketPool.available + 1;

      const ticketNumbers: number[] = [];
      for (let i = 0; i < quantity; i++) {
        ticketNumbers.push(startingTicketNumber + i);
      }

      // Bulk insert — one DB round-trip for all N tickets
      await ticketRepository.bulkInsertTickets(client, eventId, userId, ticketNumbers);

      // Decrement available — still inside the same transaction
      await ticketRepository.decrementAvailable(client, eventId, quantity);

      await client.query("COMMIT");

      return ticketNumbers;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err; // re-throw so controller sends the right error response
    } finally {
      // ALWAYS release — if we don't, pool exhausts under load
      client.release();
    }
  }

  /**
   * Entry point called by the controller.
   * Tries Redis path first; falls back to DB path if Redis is down.
   */
  async purchaseTickets(
    userId: string,
    eventId: string,
    quantity: number
  ): Promise<number[]> {
    try {
      // Only use Redis path if connection is healthy
      if (redisClient.status === "ready") {
        return await this.purchaseTicketsViaRedis(userId, eventId, quantity);
      }
    } catch (err) {
      const error = err as Error;
      // If it's a domain error (not enough tickets / event not found),
      // don't fall through to DB — surface it immediately
      if (
        error.message === "Event not found" ||
        error.message === "Not enough tickets available"
      ) {
        throw err;
      }
      console.error("[Service] Redis path failed, falling back to DB:", error.message);
    }

    return this.purchaseTicketsViaDB(userId, eventId, quantity);
  }

  /**
   * Sync Redis state from DB on startup (or when a new event is created).
   * Redis is volatile — if it restarts, we must repopulate from the source of
   * truth (PostgreSQL) before accepting purchases again.
   */
  async syncEventToRedis(eventId: string): Promise<void> {
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT total, available FROM ticket_pools WHERE event_id = $1",
        [eventId]
      );

      if (result.rows.length === 0) {
        throw new Error(`Event ${eventId} not found in DB`);
      }

      const { total, available } = result.rows[0];
      const issued = total - available;

      const pipeline = redisClient.pipeline();
      pipeline.set(RedisKeys.available(eventId), available);
      pipeline.set(RedisKeys.issuedCount(eventId), issued);
      await pipeline.exec();

      console.log(`[Service] Synced ${eventId} to Redis — available: ${available}, issued: ${issued}`);
    } finally {
      client.release();
    }
  }
}

export const ticketService = new TicketService();