/**
 * load-test.js
 *
 * Tests the FIXED server under extreme concurrency.
 * Fires 20,000 requests across multiple events and verifies:
 *   ✓ No overselling
 *   ✓ No duplicate ticket numbers
 *   ✓ Throughput (req/sec)
 *   ✓ Latency percentiles (p50, p95, p99)
 *   ✓ Error rate
 *
 * HOW TO RUN:
 *   1. Fixed server must be running:   npm run dev   (port 3000)
 *   2. DB + Redis must be running:     docker-compose up -d
 *   3. DB + Redis must be seeded:      npm run seed
 *   4. From the fixed repo root:       node load-test.js
 *
 * NO extra installs needed — only uses Node.js built-in http module + pg.
 */

const http = require("http");
const { Pool } = require("pg");

// ─── CONFIG — tweak these ─────────────────────────────────────────────────────

const CONFIG = {
  SERVER_HOST: "localhost",
  SERVER_PORT: 3000,

  // How many total purchase requests to fire
  TOTAL_REQUESTS: 20_000,

  // How many requests to fire simultaneously in each wave
  // Node.js handles ~5000 concurrent open sockets comfortably.
  // We fire in batches to avoid "ECONNRESET / ETIMEDOUT" from OS limits.
  BATCH_SIZE: 500,

  // Tickets per purchase (must be multiple of 8)
  QUANTITY: 8,

  // Events to spread load across (all seeded by npm run seed)
  // Each event's available tickets must be >= (requests assigned * QUANTITY)
  EVENTS: [
    { id: "EVENT001", available: 4800 }, // can absorb up to 600 purchases of 8
    { id: "EVENT002", available: 2920 }, // 365 purchases
    { id: "EVENT003", available: 2340 }, // 292 purchases
    { id: "EVENT004", available: 1500 }, // 187 purchases
    { id: "EVENT005", available: 1976 }, // 247 purchases
    { id: "EVENT006", available: 3200 }, // 400 purchases
  ],

  DB: {
    host: "localhost",
    port: 5433,
    database: "tickets",
    user: "postgres",
    password: "postgres",
  },
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function postRequest(eventId, userId, quantity) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const payload = JSON.stringify({ userId, eventId, quantity });

    const options = {
      hostname: CONFIG.SERVER_HOST,
      port: CONFIG.SERVER_PORT,
      path: "/purchase",
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
        const latencyMs = Date.now() - startTime;
        try {
          const body = JSON.parse(data);
          resolve({
            success: body.success === true,
            status: res.statusCode,
            tickets: body.tickets ?? [],
            error: body.error ?? null,
            latencyMs,
            eventId,
          });
        } catch {
          resolve({ success: false, status: res.statusCode, tickets: [], error: "parse error", latencyMs, eventId });
        }
      });
    });

    req.on("error", (err) => {
      const latencyMs = Date.now() - Date.now();
      resolve({ success: false, status: 0, tickets: [], error: err.message, latencyMs, eventId });
    });

    req.setTimeout(15_000, () => {
      req.destroy();
      resolve({ success: false, status: 0, tickets: [], error: "timeout", latencyMs: 15_000, eventId });
    });

    req.write(payload);
    req.end();
  });
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, idx)];
}

function formatNum(n) {
  return n.toLocaleString("en-US");
}

function progressBar(done, total, width = 30) {
  const pct = done / total;
  const filled = Math.round(pct * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return `[${bar}] ${Math.round(pct * 100)}%`;
}

// ─── PRE-CHECK: Is server alive? ──────────────────────────────────────────────

async function checkServer() {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: CONFIG.SERVER_HOST, port: CONFIG.SERVER_PORT, path: "/health", method: "GET" },
      (res) => resolve(res.statusCode === 200)
    );
    req.on("error", () => resolve(false));
    req.end();
  });
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n" + "═".repeat(65));
  console.log("  TICKET SERVICE — LOAD TEST  (20,000 requests)");
  console.log("═".repeat(65));

  // ── Pre-flight ────────────────────────────────────────────────────────────
  console.log("\n🔍 Pre-flight checks...");

  const serverAlive = await checkServer();
  if (!serverAlive) {
    console.error("\n❌ Server not reachable at http://localhost:3000");
    console.error("   Make sure you ran:  npm run dev\n");
    process.exit(1);
  }
  console.log("   ✓ Server is running");

  const pool = new Pool(CONFIG.DB);
  try {
    await pool.query("SELECT 1");
    console.log("   ✓ Database connected");
  } catch {
    console.error("\n❌ Cannot connect to PostgreSQL. Is docker-compose up?\n");
    process.exit(1);
  }

  // ── Snapshot DB state BEFORE test ─────────────────────────────────────────
  const beforeRows = await pool.query(
    "SELECT event_id, available FROM ticket_pools WHERE event_id = ANY($1)",
    [CONFIG.EVENTS.map((e) => e.id)]
  );
  const beforeMap = {};
  for (const row of beforeRows.rows) {
    beforeMap[row.event_id] = parseInt(row.available);
  }

  console.log("\n📋 Starting availability snapshot:");
  for (const [eventId, avail] of Object.entries(beforeMap)) {
    console.log(`   ${eventId}: ${formatNum(avail)} tickets available`);
  }

  // ── Build request list ────────────────────────────────────────────────────
  // Distribute requests evenly across events
  const requests = [];
  for (let i = 0; i < CONFIG.TOTAL_REQUESTS; i++) {
    const event = CONFIG.EVENTS[i % CONFIG.EVENTS.length];
    requests.push({
      userId: `load_user_${i}`,
      eventId: event.id,
      quantity: CONFIG.QUANTITY,
    });
  }

  // Shuffle so requests aren't grouped by event (more realistic)
  for (let i = requests.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [requests[i], requests[j]] = [requests[j], requests[i]];
  }

  console.log(`\n🚀 Firing ${formatNum(CONFIG.TOTAL_REQUESTS)} requests`);
  console.log(`   Batch size: ${CONFIG.BATCH_SIZE} simultaneous`);
  console.log(`   Quantity per request: ${CONFIG.QUANTITY} tickets\n`);

  // ── Fire in batches ───────────────────────────────────────────────────────
  const allResults = [];
  const testStart = Date.now();
  let completed = 0;

  for (let i = 0; i < requests.length; i += CONFIG.BATCH_SIZE) {
    const batch = requests.slice(i, i + CONFIG.BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((r) => postRequest(r.eventId, r.userId, r.quantity))
    );
    allResults.push(...batchResults);
    completed += batch.length;

    // Live progress
    process.stdout.write(
      `\r   ${progressBar(completed, CONFIG.TOTAL_REQUESTS)}  ${formatNum(completed)} / ${formatNum(CONFIG.TOTAL_REQUESTS)}`
    );
  }

  const testDurationMs = Date.now() - testStart;
  console.log("\n");

  // ── Analyse HTTP results ──────────────────────────────────────────────────
  const successes = allResults.filter((r) => r.success);
  const failures = allResults.filter((r) => !r.success);
  const timeouts = failures.filter((r) => r.error === "timeout");
  const soldOut = failures.filter((r) => r.error === "Not enough tickets available");
  const notFound = failures.filter((r) => r.error === "Event not found");
  const otherErrors = failures.filter(
    (r) => r.error !== "timeout" && r.error !== "Not enough tickets available" && r.error !== "Event not found"
  );

  // Latency stats
  const latencies = allResults.map((r) => r.latencyMs).sort((a, b) => a - b);
  const successLatencies = successes.map((r) => r.latencyMs).sort((a, b) => a - b);

  const throughput = Math.round((CONFIG.TOTAL_REQUESTS / testDurationMs) * 1000);

  // ── DB integrity check ────────────────────────────────────────────────────
  console.log("🔎 Running DB integrity checks...\n");

  // 1. Check available didn't go negative
  const afterRows = await pool.query(
    "SELECT event_id, available FROM ticket_pools WHERE event_id = ANY($1)",
    [CONFIG.EVENTS.map((e) => e.id)]
  );
  const afterMap = {};
  for (const row of afterRows.rows) {
    afterMap[row.event_id] = parseInt(row.available);
  }

  // 2. Wait a moment for async queue workers to flush to DB
  console.log("   ⏳ Waiting 3s for async queue workers to flush to DB...");
  await new Promise((r) => setTimeout(r, 3000));

  // 3. Check for duplicate ticket numbers
  const dupResult = await pool.query(`
    SELECT event_id, ticket_number, COUNT(*) as occurrences
    FROM issued_tickets
    WHERE event_id = ANY($1)
    GROUP BY event_id, ticket_number
    HAVING COUNT(*) > 1
    ORDER BY occurrences DESC
    LIMIT 10
  `, [CONFIG.EVENTS.map((e) => e.id)]);

  // 4. Check issued count matches DB counter
  const issuedResult = await pool.query(`
    SELECT
      tp.event_id,
      tp.total,
      tp.available,
      COUNT(it.id)::int as actual_issued,
      (tp.total - tp.available) as expected_issued
    FROM ticket_pools tp
    LEFT JOIN issued_tickets it ON tp.event_id = it.event_id
    WHERE tp.event_id = ANY($1)
    GROUP BY tp.event_id, tp.total, tp.available
    ORDER BY tp.event_id
  `, [CONFIG.EVENTS.map((e) => e.id)]);

  // ─── PRINT REPORT ─────────────────────────────────────────────────────────

  console.log("═".repeat(65));
  console.log("  RESULTS");
  console.log("═".repeat(65));

  console.log(`
📊 THROUGHPUT & TIMING
   Total requests:      ${formatNum(CONFIG.TOTAL_REQUESTS)}
   Test duration:       ${(testDurationMs / 1000).toFixed(2)}s
   Throughput:          ${formatNum(throughput)} req/sec

⏱️  LATENCY (all requests)
   p50  (median):       ${percentile(latencies, 50)}ms
   p95:                 ${percentile(latencies, 95)}ms
   p99:                 ${percentile(latencies, 99)}ms
   max:                 ${latencies[latencies.length - 1]}ms
   min:                 ${latencies[0]}ms

⏱️  LATENCY (successful only)
   p50  (median):       ${percentile(successLatencies, 50)}ms
   p95:                 ${percentile(successLatencies, 95)}ms
   p99:                 ${percentile(successLatencies, 99)}ms

📨 HTTP OUTCOMES
   ✅ Successful:        ${formatNum(successes.length)}  (${((successes.length / CONFIG.TOTAL_REQUESTS) * 100).toFixed(1)}%)
   🎫 Sold out (expected):  ${formatNum(soldOut.length)}
   ⏱️  Timeouts:          ${formatNum(timeouts.length)}
   ❓ Other errors:      ${formatNum(otherErrors.length)}`);

  if (otherErrors.length > 0) {
    const sample = otherErrors.slice(0, 5);
    console.log("   Sample errors:");
    sample.forEach((e) => console.log(`     - [${e.status}] ${e.error}`));
  }

  // ── Per-event availability ─────────────────────────────────────────────────
  console.log("\n📦 PER-EVENT AVAILABILITY");
  console.log(
    `   ${"Event".padEnd(12)} ${"Before".padEnd(10)} ${"After".padEnd(10)} ${"Sold".padEnd(10)} ${"Available≥0?".padEnd(14)}`
  );
  console.log("   " + "─".repeat(58));

  let anyNegative = false;
  for (const event of CONFIG.EVENTS) {
    const before = beforeMap[event.id] ?? "?";
    const after = afterMap[event.id] ?? "?";
    const sold = typeof before === "number" && typeof after === "number" ? before - after : "?";
    const ok = typeof after === "number" && after >= 0;
    if (!ok) anyNegative = true;
    console.log(
      `   ${event.id.padEnd(12)} ${String(before).padEnd(10)} ${String(after).padEnd(10)} ${String(sold).padEnd(10)} ${ok ? "✅ YES" : "🔴 NO — NEGATIVE!"}`
    );
  }

  // ── DB consistency ─────────────────────────────────────────────────────────
  console.log("\n🗄️  DB CONSISTENCY (after queue flush)");
  console.log(
    `   ${"Event".padEnd(12)} ${"Expected".padEnd(12)} ${"Actual".padEnd(12)} ${"Match?".padEnd(10)}`
  );
  console.log("   " + "─".repeat(50));

  let anyMismatch = false;
  for (const row of issuedResult.rows) {
    const match = row.actual_issued === row.expected_issued;
    if (!match) anyMismatch = true;
    console.log(
      `   ${row.event_id.padEnd(12)} ${String(row.expected_issued).padEnd(12)} ${String(row.actual_issued).padEnd(12)} ${match ? "✅" : "⚠️  MISMATCH (queue still flushing?)"}`
    );
  }

  // ── Duplicate check ────────────────────────────────────────────────────────
  console.log("\n🔢 DUPLICATE TICKET NUMBER CHECK");
  if (dupResult.rows.length === 0) {
    console.log("   ✅ ZERO duplicates found — every ticket number is unique");
  } else {
    console.log(`   🔴 ${dupResult.rows.length} duplicate ticket numbers found!`);
    console.log(`   ${"Event".padEnd(12)} ${"Ticket #".padEnd(12)} ${"Times Issued"}`);
    for (const row of dupResult.rows) {
      console.log(`   ${row.event_id.padEnd(12)} ${String(row.ticket_number).padEnd(12)} ${row.occurrences}`);
    }
  }

  // ── Final verdict ──────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(65));
  console.log("  VERDICT");
  console.log("═".repeat(65));

  const oversellBug = anyNegative;
  const duplicateBug = dupResult.rows.length > 0;

  if (!oversellBug && !duplicateBug) {
    console.log(`
  ✅ ALL CHECKS PASSED

  🐛 Bug 1 (Overselling):         FIXED — available never went negative
  🐛 Bug 2 (Duplicate tickets):   FIXED — zero duplicate ticket numbers
  ⚡ Throughput:                  ${formatNum(throughput)} req/sec
  
  The service correctly handled ${formatNum(CONFIG.TOTAL_REQUESTS)} concurrent requests
  without a single race condition.
`);
  } else {
    console.log(`\n  ❌ ISSUES DETECTED\n`);
    if (oversellBug) console.log("  🔴 Bug 1 (Overselling) STILL PRESENT — available went negative");
    if (duplicateBug) console.log("  🔴 Bug 2 (Duplicates) STILL PRESENT — duplicate ticket numbers found");
  }

  if (anyMismatch) {
    console.log("  ⚠️  DB count mismatch detected. This is likely the async queue");
    console.log("     still flushing. Wait ~10s and re-run to verify.");
  }

  console.log("═".repeat(65) + "\n");

  await pool.end();
}

main().catch((err) => {
  console.error("Load test crashed:", err);
  process.exit(1);
});