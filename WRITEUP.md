# Write-Up: Bug Analysis, Fix & Scalable Architecture

---

## 1. The Bugs — What Was Going Wrong

### Original Code (ticketService.ts)

```typescript
export async function purchaseTickets(userId, eventId, quantity) {

  // Operation 1: Read available count from DB
  const result = await pool.query(
    "SELECT * FROM ticket_pools WHERE event_id = $1", [eventId]
  );
  const ticketPool = result.rows[0];

  // Operation 2: Check if enough tickets
  if (ticketPool.available < quantity) {
    throw new Error("Not enough tickets available");
  }

  // Operation 3: Calculate starting ticket number
  const currentTotal = ticketPool.total - ticketPool.available;

  // Operation 4: Insert tickets one by one (N separate queries)
  for (let i = 0; i < quantity; i++) {
    await pool.query("INSERT INTO issued_tickets ...", [ticketNumber]);
  }

  // Operation 5: Update available count
  await pool.query("UPDATE ticket_pools SET available = available - $1 ...");
}
```

These are five completely **separate, uncoordinated database operations** with
no transaction and no lock binding them together. Between Operation 1 and
Operation 5, the database has no idea a purchase is in progress. Any number
of concurrent requests can interleave their own Operations 1–5 freely.

---

### Bug 1 — Overselling: TOCTOU Race Condition

**TOCTOU stands for Time-of-Check, Time-of-Use.** It is the class of bug where
a condition is checked at one point in time, but the action based on that check
happens at a later point in time — and the state can change in between.

Here is the exact timeline with 200 concurrent users and 8 tickets remaining:

```
Time      Request A                        Request B
──────────────────────────────────────────────────────────────────
t=0ms     SELECT available → returns 8
t=1ms                                      SELECT available → returns 8
t=2ms     available(8) >= quantity(8) ✓
t=3ms                                      available(8) >= quantity(8) ✓
t=4ms     INSERT ticket #1...
t=5ms                                      INSERT ticket #1...  ← SAME NUMBER
t=6ms     UPDATE available = 0
t=7ms                                      UPDATE available = -8  ← NEGATIVE
```

Both requests passed the availability check because they both read the **same
stale value** of `available = 8` before either of them had written their update.
This is not a logic error — the logic is correct in isolation. The problem is
that the logic is not atomic. Under concurrency, the check and the update are
separated by time, and in that gap, other requests execute their own checks.

With 200 simultaneous requests, all 200 can read `available = 8`, all 200 pass
the check, and all 200 proceed to issue tickets — resulting in 1600 tickets
issued when only 8 were available.

---

### Bug 2 — Duplicate Ticket Numbers: Same Root Cause

Ticket numbers are generated from:
```typescript
const currentTotal = ticketPool.total - ticketPool.available;
const ticketNumber = currentTotal + i + 1;
```

If Request A and Request B both read `available = 100`, they both compute
`currentTotal = 400` and both generate the sequence 401, 402, 403...
Multiple users end up holding identical ticket numbers for the same event.

Both bugs share one root cause: **the read-check-write sequence is not atomic.**

---

## 2. Approaches Considered

### Approach 1 — Application-Level Mutex (Rejected)

Use a JavaScript `Map` to hold a lock per `eventId` in memory:
```typescript
const locks = new Map();
if (locks.has(eventId)) { throw new Error("Busy, retry"); }
locks.set(eventId, true);
// ... purchase logic ...
locks.delete(eventId);
```

**Why rejected:** Works only on a single server instance. The moment you run
two instances behind a load balancer, each instance has its own isolated
in-memory map. Requests hitting different instances have no awareness of each
other's locks. The race condition returns across instances — exactly the
scenario the bonus task requires solving.

---

### Approach 2 — Optimistic Locking with Version Column (Rejected)

Add a `version` INTEGER column to `ticket_pools`. Read `version`, do the
purchase, then `UPDATE ... WHERE version = $old_version`. If 0 rows were
updated, someone else changed the row first — retry.

**Why rejected:** Under high concurrency, most transactions fail their version
check and must retry. If 500 requests arrive simultaneously, 1 succeeds and
499 retry. On the next attempt, 1 succeeds and 498 retry. This creates
**retry storms** — the system is constantly churning failed attempts and
retries instead of making progress. Latency climbs non-linearly with load.
Unsuitable for a high-demand launch scenario.

---

### Approach 3 — PostgreSQL SELECT FOR UPDATE (Chosen as Basic Fix)

Wrap the entire operation in a PostgreSQL transaction and acquire a
**row-level exclusive lock** using `SELECT ... FOR UPDATE`:

```sql
BEGIN;
SELECT * FROM ticket_pools WHERE event_id = $1 FOR UPDATE;
-- Any concurrent transaction attempting this same SELECT FOR UPDATE
-- on the same row is BLOCKED at the database engine level until
-- this transaction COMMITs or ROLLBACKs.
INSERT INTO issued_tickets ...
UPDATE ticket_pools SET available = available - $1 ...
COMMIT;
-- Lock released here. Next blocked transaction proceeds with
-- the updated (correct) value of available.
```

**Why this works:** PostgreSQL's MVCC transaction engine guarantees that only
one transaction can hold an exclusive row lock at a time. Concurrent requests
queue inside the database — not in application code — and each one proceeds
only after seeing the committed, correct state left by the previous transaction.

**Tradeoff:** All purchases for the same event are serialised. One lock holder
at a time. For moderate concurrency (thousands of req/sec on a single DB
instance), this is perfectly adequate. The lock hold time is short — just the
duration of the INSERT + UPDATE — so throughput is still high. But at very high
scale with multiple server instances, all requests converge on a single DB row
lock, which becomes a serialisation bottleneck.

---

### Approach 4 — Redis Lua Script + BullMQ Async Queue (Chosen as Scale Fix)

Move the **critical section** — the availability check and reservation — out of
PostgreSQL and into Redis. Use a **Lua script** for atomicity. Use a **BullMQ
job queue** for reliable asynchronous DB persistence.

**Why Redis for the critical section:** Redis is single-threaded by design. It
processes one command at a time. Lua scripts execute as a single atomic unit —
Redis pauses all other commands for the script's entire duration. This gives
the same guarantee as `SELECT FOR UPDATE`, but at Redis speed (~0.1ms vs ~5ms
for a PostgreSQL round-trip), and it works across **multiple server instances**
because all instances share the same Redis.

**Why BullMQ for DB persistence:** After Redis atomically reserves the tickets,
the user already has their ticket numbers. The DB write (inserting rows and
updating the counter) does not need to block the HTTP response. BullMQ provides
**at-least-once delivery** — if the worker crashes mid-job, BullMQ retries
automatically with exponential backoff. The job is not removed from the queue
until the worker explicitly acknowledges success.

**Tradeoffs of this approach:**
- Adds Redis as a required infrastructure dependency
- Introduces eventual consistency between Redis and PostgreSQL (mitigated by
  BullMQ's delivery guarantees and Redis AOF persistence)
- Redis restart requires re-sync from PostgreSQL (handled by `syncEventToRedis()`
  called on every server startup)
- More complex failure recovery than the pure DB approach — but the tradeoff is
  justified by the order-of-magnitude throughput improvement

---

## 3. The Implementation

### Core Fix 1 — SELECT FOR UPDATE (DB Fallback Path)

```typescript
// src/repositories/ticketRepository.ts
async lockAndGetPool(client: PoolClient, eventId: string) {
  const result = await client.query(
    "SELECT * FROM ticket_pools WHERE event_id = $1 FOR UPDATE",
    [eventId]
  );
  return result.rows[0] ?? null;
}
```

```typescript
// src/services/ticketService.ts — purchaseTicketsViaDB()
const client = await pool.connect();
try {
  await client.query("BEGIN");

  // Acquires exclusive row lock — concurrent transactions block here
  const ticketPool = await ticketRepository.lockAndGetPool(client, eventId);

  if (!ticketPool) throw new Error("Event not found");
  if (ticketPool.available < quantity) throw new Error("Not enough tickets available");

  // Safe to calculate — we hold the lock, nobody else can change available
  const start = ticketPool.total - ticketPool.available + 1;
  const ticketNumbers = Array.from({ length: quantity }, (_, i) => start + i);

  // One DB round-trip for all N rows using unnest()
  await ticketRepository.bulkInsertTickets(client, eventId, userId, ticketNumbers);
  await ticketRepository.decrementAvailable(client, eventId, quantity);

  await client.query("COMMIT"); // lock released here
  return ticketNumbers;
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  client.release(); // always return connection to pool
}
```

**Bulk insert with unnest():** The original code issued one INSERT per ticket
(N round-trips). The fix uses PostgreSQL's `unnest()` function to expand
parallel arrays into rows — one query regardless of how many tickets:

```sql
INSERT INTO issued_tickets (event_id, user_id, ticket_number)
SELECT * FROM unnest($1::text[], $2::text[], $3::int[])
```

**Database-level constraints as last line of defence:**
```sql
CONSTRAINT unique_ticket_per_event UNIQUE (event_id, ticket_number)
CONSTRAINT available_non_negative CHECK (available >= 0)
```
Even if application logic had a bug, the database would reject the
offending operation outright rather than silently corrupting data.

---

### Core Fix 2 — Redis Lua Script (Scale Path)

```lua
-- Executes atomically — no other Redis command runs during this script
local available = tonumber(redis.call('GET', KEYS[1]))
if available == nil then return -2 end           -- event not found in Redis
if available < tonumber(ARGV[1]) then return -1 end  -- not enough tickets

redis.call('DECRBY', KEYS[1], ARGV[1])           -- decrement available counter
local new_issued = redis.call('INCRBY', KEYS[2], ARGV[1])  -- increment issued counter
return new_issued - ARGV[1] + 1                  -- return starting ticket number
```

The script returns the **starting ticket number** for this purchase. Because
`INCRBY` is atomic and sequential, each concurrent invocation gets a
non-overlapping range. There is no possibility of two scripts returning
overlapping ranges.

---

### Core Fix 3 — BullMQ Worker

```typescript
// src/workers/ticketWorker.ts
async (job: Job<TicketPersistJob>) => {
  const { userId, eventId, ticketNumbers } = job.data;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ticketRepository.bulkInsertTickets(client, eventId, userId, ticketNumbers);
    await ticketRepository.decrementAvailable(client, eventId, ticketNumbers.length);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;  // BullMQ catches this, marks job failed, schedules retry
  } finally {
    client.release();
  }
}
```

`throw err` is critical — BullMQ only retries jobs that throw. The
`attempts: 5` with `backoff: { type: "exponential", delay: 500 }` means
retries happen at 500ms, 1s, 2s, 4s, 8s — giving the DB time to recover
from transient failures before the next attempt.

---

### Intelligent Fallback

```typescript
async purchaseTickets(userId, eventId, quantity) {
  try {
    if (redisClient.status === "ready") {
      return await this.purchaseTicketsViaRedis(userId, eventId, quantity);
    }
  } catch (err) {
    // Surface domain errors immediately — don't fall through
    if (err.message === "Event not found" ||
        err.message === "Not enough tickets available") {
      throw err;
    }
    // Infrastructure error — fall back to DB path
    console.error("[Service] Redis failed, falling back to DB:", err.message);
  }
  return this.purchaseTicketsViaDB(userId, eventId, quantity);
}
```

Domain errors (event not found, sold out) are rethrown immediately — they
should not trigger a fallback. Only infrastructure errors (Redis connection
failure, Lua execution error) trigger the DB fallback.

---

## 4. Architecture: Full Request Flow

```
POST /purchase { userId, eventId, quantity }
        │
        ▼
┌─────────────────────────────────┐
│         Validator               │  Rejects: missing fields, non-integer
│  purchaseValidator.ts           │  quantity, quantity not multiple of 8
└─────────────────────────────────┘
        │ valid
        ▼
┌─────────────────────────────────┐
│        Controller               │  No business logic. Calls service.
│  ticketController.ts            │  Maps result/error to HTTP status codes.
└─────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────┐
│         Service                 │  Decides Redis path vs DB path.
│  ticketService.ts               │  Owns all business rules.
└────────────┬────────────────────┘
             │
    ┌────────┴─────────┐
    │ Redis ready?     │
   YES                NO
    │                  │
    ▼                  ▼
┌────────────┐   ┌──────────────────────────┐
│ Lua Script │   │  PostgreSQL Transaction  │
│ (atomic)   │   │  SELECT FOR UPDATE       │
│ ~0.1ms     │   │  bulkInsertTickets       │
└─────┬──────┘   │  decrementAvailable      │
      │          │  COMMIT                  │
      │          └──────────────────────────┘
      │ starting ticket number
      ▼
┌────────────────┐
│  BullMQ Queue  │  Job: { userId, eventId, ticketNumbers }
│  ticketQueue   │  Options: 5 attempts, exponential backoff
└──────┬─────────┘
       │ ← User response returned HERE (fast path complete)
       │
       │ async, background
       ▼
┌──────────────────────────────────┐
│         BullMQ Worker            │
│  ticketWorker.ts                 │
│  BEGIN TRANSACTION               │
│  bulkInsertTickets (unnest)      │
│  decrementAvailable              │
│  COMMIT                          │
│  (retry on failure, up to 5x)   │
└──────────────────────────────────┘
```

---

## 5. Why This Is Production-Grade

**Redis AOF Persistence:** Configured with `--appendonly yes` in
`docker-compose.yml`. Every write command is logged to disk. If Redis
restarts, it replays the log and recovers full state. No reservations are lost.

**Startup Re-sync:** On every server start, `syncEventToRedis()` reads
PostgreSQL `ticket_pools` and overwrites Redis counters. PostgreSQL is always
the source of truth. Redis is a high-speed cache of that truth.

**DB-Level Constraints:** `UNIQUE (event_id, ticket_number)` and
`CHECK (available >= 0)` ensure data integrity even if application logic fails.

**Connection Pool Discipline:** Every DB client acquired from `pool.connect()`
is released in a `finally` block — ensuring no connection leaks under any
failure scenario.

**Structured Error Handling:** Domain errors (400), infrastructure errors (500),
and fallback logic are all explicitly separated. The caller always receives a
meaningful, correctly-coded HTTP response.

**Separation of Concerns:** Validator → Controller → Service → Repository.
Each layer has exactly one responsibility. SQL lives only in the repository.
HTTP logic lives only in the controller. Business rules live only in the service.