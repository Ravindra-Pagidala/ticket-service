import { PoolClient } from "pg";
import { TicketPool } from "../types";


/**
 * Repository layer: raw SQL only.
 * No business logic here — that lives in the service.
 * Every method receives a PoolClient so the caller controls
 * the transaction boundary.
 */
export class TicketRepository {
  /**
   * Lock the ticket_pool row for this event for the duration of the
   * current transaction. Any other transaction that tries to SELECT
   * the same row with FOR UPDATE will BLOCK here until we COMMIT or
   * ROLLBACK. This is the core of the race condition fix.
   */
  async lockAndGetPool(
    client: PoolClient,
    eventId: string
  ): Promise<TicketPool | null> {
    const result = await client.query<TicketPool>(
      "SELECT * FROM ticket_pools WHERE event_id = $1 FOR UPDATE",
      [eventId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Decrement available count. Called inside the same transaction as
   * lockAndGetPool so the decrement is atomic with the availability check.
   */
  async decrementAvailable(
    client: PoolClient,
    eventId: string,
    quantity: number
  ): Promise<void> {
    await client.query(
      "UPDATE ticket_pools SET available = available - $1 WHERE event_id = $2",
      [quantity, eventId]
    );
  }

  /**
   * Bulk-insert all ticket rows for one purchase in a single query.
   * Using unnest() is far more efficient than N separate INSERT statements
   * — one round-trip to the DB instead of N.
   */
  async bulkInsertTickets(
    client: PoolClient,
    eventId: string,
    userId: string,
    ticketNumbers: number[]
  ): Promise<void> {
    // Build parallel arrays that unnest() expands into rows
    const eventIds = ticketNumbers.map(() => eventId);
    const userIds = ticketNumbers.map(() => userId);

    await client.query(
      `INSERT INTO issued_tickets (event_id, user_id, ticket_number)
       SELECT * FROM unnest($1::text[], $2::text[], $3::int[])`,
      [eventIds, userIds, ticketNumbers]
    );
  }

  /**
   * Used by the async worker to persist tickets written via the Redis path.
   * Runs outside any caller-managed transaction — opens its own client.
   */
  async bulkInsertTicketsStandalone(
    client: PoolClient,
    eventId: string,
    userId: string,
    ticketNumbers: number[]
  ): Promise<void> {
    return this.bulkInsertTickets(client, eventId, userId, ticketNumbers);
  }
}

export const ticketRepository = new TicketRepository();