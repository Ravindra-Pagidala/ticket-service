/**
 * reproduce-bugs.js
 *
 * PURPOSE: Demonstrate race condition bugs in the ORIGINAL unmodified codebase.
 * - Bug 1: Overselling — more tickets sold than available
 * - Bug 2: Duplicate ticket numbers — multiple users get same ticket number
 *
 * HOW TO RUN:
 *   1. Make sure the ORIGINAL server is running:  npm run dev  (on port 3000)
 *   2. Make sure DB is seeded:                    npm run seed
 *   3. In a NEW terminal from the original repo root:
 *        node reproduce-bugs.js
 *
 * DEPENDENCIES: Only uses Node.js built-ins (http) + pg (already in package.json)
 * No extra installs needed.
 */

const http = require("http");
const { Pool } = require("pg");

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const SERVER_URL = "http://localhost:3000";
const EVENT_ID = "EVENT004"; // Comedy Night — starts with exactly 1500 available, clean slate
const QUANTITY = 8; // each user buys 8 tickets
const CONCURRENCY = 200; // 200 simultaneous requests = 1600 tickets attempted (> 1500 limit)
// This guarantees we cross the availability threshold under race conditions

const DB_CONFIG = {
  host: "localhost",
  port: 5433,
  database: "tickets",
  user: "postgres",
  password: "postgres",
};

// ─── HTTP HELPER (no axios needed) ───────────────────────────────────────────

function postRequest(path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: "localhost",
      port: 3000,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on("error", (err) => {
      resolve({ status: 0, body: { error: err.message } });
    });

    req.write(payload);
    req.end();
  });
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const pool = new Pool(DB_CONFIG);

  console.log("=".repeat(60));
  console.log("  RACE CONDITION BUG REPRODUCTION SCRIPT");
  console.log("=".repeat(60));

  // ── Step 1: Confirm starting state ────────────────────────────────────────
  const before = await pool.query(
    "SELECT available, total FROM ticket_pools WHERE event_id = $1",
    [EVENT_ID]
  );

  if (before.rows.length === 0) {
    console.error(
      `\n❌ Event ${EVENT_ID} not found. Did you run: npm run seed ?\n`
    );
    await pool.end();
    process.exit(1);
  }

  const startingAvailable = before.rows[0].available;
  const total = before.rows[0].total;

  console.log(`\n📋 Event: ${EVENT_ID}`);
  console.log(`   Total tickets:     ${total}`);
  console.log(`   Available before:  ${startingAvailable}`);
  console.log(`   Concurrency:       ${CONCURRENCY} simultaneous requests`);
  console.log(`   Each buys:         ${QUANTITY} tickets`);
  console.log(
    `   Total attempted:   ${CONCURRENCY * QUANTITY} tickets (intentionally exceeds available)\n`
  );

  // ── Step 2: Fire all requests simultaneously ───────────────────────────────
  console.log(
    `🚀 Firing ${CONCURRENCY} simultaneous purchase requests NOW...\n`
  );

  const requests = Array.from({ length: CONCURRENCY }, (_, i) =>
    postRequest("/purchase", {
      userId: `stress_user_${i}`,
      eventId: EVENT_ID,
      quantity: QUANTITY,
    })
  );

  const results = await Promise.all(requests);

  // ── Step 3: Analyse HTTP responses ────────────────────────────────────────
  const successes = results.filter((r) => r.body && r.body.success === true);
  const failures = results.filter((r) => !r.body || r.body.success !== true);

  console.log(`📊 HTTP Results:`);
  console.log(`   Successful purchases: ${successes.length}`);
  console.log(`   Failed purchases:     ${failures.length}`);
  console.log(
    `   Tickets that SHOULD have been sold (max): ${startingAvailable}`
  );
  console.log(
    `   Tickets reported sold by server:          ${successes.length * QUANTITY}\n`
  );

  // ── Step 4: Check DB for oversell ─────────────────────────────────────────
  const after = await pool.query(
    "SELECT available FROM ticket_pools WHERE event_id = $1",
    [EVENT_ID]
  );

  const availableAfter = after.rows[0].available;
  const soldAccordingToDb = startingAvailable - availableAfter;

  console.log(`🗄️  Database State After:`);
  console.log(`   Available remaining: ${availableAfter}`);
  console.log(`   Sold (DB counter):   ${soldAccordingToDb}`);

  // ── Step 5: Check DB for actual issued ticket count ────────────────────────
  const issuedCount = await pool.query(
    "SELECT COUNT(*) as count FROM issued_tickets WHERE event_id = $1",
    [EVENT_ID]
  );
  const actualIssued = parseInt(issuedCount.rows[0].count);

  console.log(`   Actual rows in issued_tickets: ${actualIssued}\n`);

  // ── Step 6: Check for duplicate ticket numbers ────────────────────────────
  const duplicates = await pool.query(
    `SELECT ticket_number, COUNT(*) as occurrences
     FROM issued_tickets
     WHERE event_id = $1
     GROUP BY ticket_number
     HAVING COUNT(*) > 1
     ORDER BY occurrences DESC
     LIMIT 20`,
    [EVENT_ID]
  );

  // ── Step 7: Print Bug Report ───────────────────────────────────────────────
  console.log("=".repeat(60));
  console.log("  BUG REPORT");
  console.log("=".repeat(60));

  // Bug 1: Oversell
  const oversellDetected = availableAfter < 0 || actualIssued > startingAvailable;
  if (oversellDetected) {
    console.log(`\n🔴 BUG 1 CONFIRMED — OVERSELLING`);
    console.log(`   Started with ${startingAvailable} available tickets.`);
    console.log(`   ${actualIssued} tickets were actually issued.`);
    if (availableAfter < 0) {
      console.log(`   'available' column went NEGATIVE: ${availableAfter}`);
    }
    console.log(
      `   Oversold by: ${actualIssued - startingAvailable} tickets`
    );
  } else {
    console.log(`\n🟡 BUG 1 — OVERSELL: Not triggered this run.`);
    console.log(
      `   Try increasing CONCURRENCY at the top of this file and re-run.`
    );
  }

  // Bug 2: Duplicates
  if (duplicates.rows.length > 0) {
    console.log(`\n🔴 BUG 2 CONFIRMED — DUPLICATE TICKET NUMBERS`);
    console.log(
      `   Found ${duplicates.rows.length} ticket numbers issued more than once:\n`
    );
    console.log(
      `   ${"Ticket #".padEnd(12)} ${"Times Issued".padEnd(15)}`
    );
    console.log(`   ${"-".repeat(28)}`);
    duplicates.rows.forEach((row) => {
      console.log(
        `   ${String(row.ticket_number).padEnd(12)} ${String(row.occurrences).padEnd(15)}`
      );
    });

    // Show which users got the same ticket
    if (duplicates.rows.length > 0) {
      const firstDupe = duplicates.rows[0].ticket_number;
      const whoGotIt = await pool.query(
        `SELECT user_id, ticket_number, created_at
         FROM issued_tickets
         WHERE event_id = $1 AND ticket_number = $2
         ORDER BY created_at`,
        [EVENT_ID, firstDupe]
      );
      console.log(
        `\n   Example — Ticket #${firstDupe} was given to ALL these users:`
      );
      whoGotIt.rows.forEach((r) => {
        console.log(`     - ${r.user_id} at ${r.created_at}`);
      });
    }
  } else {
    console.log(`\n🟡 BUG 2 — DUPLICATES: Not triggered this run.`);
    console.log(
      `   Try increasing CONCURRENCY at the top of this file and re-run.`
    );
  }

  // ── Step 8: Root Cause Explanation ────────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ROOT CAUSE`);
  console.log("=".repeat(60));
  console.log(`
  In ticketService.ts, purchaseTickets() does this WITHOUT a transaction:

    1. READ  available from ticket_pools   ← Thread A reads: available = 8
                                           ← Thread B reads: available = 8  (same!)
    2. CHECK if available >= quantity      ← Both pass the check
    3. CALCULATE ticket numbers from total ← Both calculate same starting number
    4. INSERT into issued_tickets          ← Both insert the same ticket numbers
    5. UPDATE available - quantity         ← available goes to -8 (oversold!)

  Steps 1–5 are NOT atomic. Between step 1 and step 5, hundreds of other
  requests can read the same stale 'available' value and pass the check.
  This is a classic Time-of-Check / Time-of-Use (TOCTOU) race condition.

  FIX: Wrap everything in a PostgreSQL transaction with SELECT...FOR UPDATE
  to lock the row, preventing any other request from reading it until the
  transaction commits.
  `);

  await pool.end();
  console.log("Script complete.\n");
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});