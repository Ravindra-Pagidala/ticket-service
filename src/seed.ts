import { Pool } from "pg";
import Redis from "ioredis";

const pool = new Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5433),
  database: process.env.DB_NAME ?? "tickets",
  user: process.env.DB_USER ?? "postgres",
  password: process.env.DB_PASSWORD ?? "postgres",
});

const redis = new Redis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
});

const events = [
  { id: "EVENT001", name: "Summer Music Festival",  total: 5000, available: 4800, soldTickets: 200 },
  { id: "EVENT002", name: "Tech Conference 2024",   total: 3000, available: 2920, soldTickets: 80  },
  { id: "EVENT003", name: "Food & Wine Expo",       total: 2500, available: 2340, soldTickets: 160 },
  { id: "EVENT004", name: "Comedy Night",           total: 1500, available: 1500, soldTickets: 0   },
  { id: "EVENT005", name: "Art Gallery Opening",    total: 2000, available: 1976, soldTickets: 24  },
  { id: "EVENT006", name: "Rock Concert",           total: 4000, available: 3200, soldTickets: 800 },
];

async function seedDatabase(): Promise<void> {
  console.log("Starting database seeding...");

  await pool.query("TRUNCATE TABLE issued_tickets CASCADE");
  await pool.query("DELETE FROM ticket_pools");

  for (const event of events) {
    await pool.query(
      "INSERT INTO ticket_pools (event_id, total, available) VALUES ($1, $2, $3)",
      [event.id, event.total, event.available]
    );
    console.log(`  ✓ ${event.id}: ${event.name} — available: ${event.available}`);
  }

  for (const event of events) {
    if (event.soldTickets > 0) {
      // Bulk insert using unnest for performance
      const eventIds: string[] = [];
      const userIds: string[] = [];
      const ticketNumbers: number[] = [];

      for (let i = 1; i <= event.soldTickets; i++) {
        eventIds.push(event.id);
        userIds.push(`user_${Math.floor((i - 1) / 8) + 1}_${event.id}`);
        ticketNumbers.push(i);
      }

      await pool.query(
        `INSERT INTO issued_tickets (event_id, user_id, ticket_number)
         SELECT * FROM unnest($1::text[], $2::text[], $3::int[])`,
        [eventIds, userIds, ticketNumbers]
      );
    }
  }

  console.log("\nSample issued tickets created");
}

async function seedRedis(): Promise<void> {
  console.log("\nSyncing Redis...");

  const pipeline = redis.pipeline();
  for (const event of events) {
    pipeline.set(`ticket:${event.id}:available`, event.available);
    pipeline.set(`ticket:${event.id}:issued_count`, event.soldTickets);
  }
  await pipeline.exec();

  console.log("  ✓ Redis synced with DB state");
}

async function verifyConsistency(): Promise<void> {
  const result = await pool.query(`
    SELECT
      tp.event_id,
      tp.total,
      tp.available,
      COUNT(it.id)::int as issued_count,
      (tp.total - tp.available) as should_be_issued,
      CASE WHEN COUNT(it.id) = (tp.total - tp.available) THEN 'OK' ELSE 'MISMATCH!' END as status
    FROM ticket_pools tp
    LEFT JOIN issued_tickets it ON tp.event_id = it.event_id
    GROUP BY tp.event_id, tp.total, tp.available
    ORDER BY tp.event_id
  `);

  console.log("\n=== Data Consistency Check ===");
  console.table(result.rows);
}

async function main(): Promise<void> {
  try {
    await seedDatabase();
    await seedRedis();
    await verifyConsistency();
    console.log("\nSeeding completed successfully!");
  } catch (err) {
    console.error("Seeding failed:", err);
    process.exit(1);
  } finally {
    await pool.end();
    await redis.quit();
  }
}

main();