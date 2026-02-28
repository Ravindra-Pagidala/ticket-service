# Ticket Service — Race-Condition-Safe, Redis-Backed

A high-performance ticket provisioning service that handles tens of thousands of
concurrent purchase requests without overselling or issuing duplicate ticket numbers.

---

## What Was Wrong With the Original

The original `ticketService.ts` had a **race condition**. The `purchaseTickets()`
function performed five completely separate, uncoordinated database operations —
read availability, check it, calculate ticket numbers, insert rows, update counter —
with zero transactional protection between them. Under concurrent load, multiple
requests would read the same stale value before any of them updated it, causing
both overselling and duplicate ticket numbers. See `WRITEUP.md` for the full analysis.

---

## Prerequisites

- Node.js 18+
- Docker + Docker Compose
- npm

---

## Setup & Run

### 1. Install dependencies
```bash
npm install
```

### 2. Start PostgreSQL + Redis
```bash
docker-compose up -d
```

### 3. Seed the database and Redis
```bash
npm run seed
```

### 4. Start the server
```bash
npm run dev
```
Server runs on `http://localhost:3000`

### 5. Verify with a test purchase
```bash
curl -X POST http://localhost:3000/purchase \
  -H "Content-Type: application/json" \
  -d '{"userId":"user1","eventId":"EVENT001","quantity":8}'
```

Expected:
```json
{ "success": true, "tickets": [201, 202, 203, 204, 205, 206, 207, 208] }
```

---

## Testing — Two Scripts, Two Codebases

### Script 1 — `reproduce-bugs.js`
**Purpose:** Proves both bugs exist in the ORIGINAL unmodified codebase.
**Must be run against:** The original repo — NOT this one.

```bash
# Clone the original separately
git clone https://github.com/markopolo-inc/swe-1-assignment ticket-service-original
cd ticket-service-original
docker-compose up -d
npm install
npm run seed
npm run dev                  # keep running on port 3000

# New terminal — from original repo root
node reproduce-bugs.js
```

Expected output:
```
🔴 BUG 1 CONFIRMED — OVERSELLING
   Started with 1500 available. 1568 issued. Oversold by: 68

🔴 BUG 2 CONFIRMED — DUPLICATE TICKET NUMBERS
   Found 43 ticket numbers issued more than once
   Ticket #1 was given to: stress_user_4, stress_user_17, stress_user_89
```

---

### Script 2 — `load-test.js`
**Purpose:** Proves both bugs are FIXED under 20,000 concurrent requests.
**Run against:** This fixed codebase.

```bash
# Terminal 1 — fixed server
npm run seed       # always re-seed before each test run
npm run dev

# Terminal 2
node load-test.js
```

Expected output:
```
✅ Bug 1 (Overselling):        FIXED — available never went negative
✅ Bug 2 (Duplicate tickets):  FIXED — zero duplicate ticket numbers
⚡ Throughput:                 ~3,000 req/sec on localhost
```

> **Important:** Run `npm run seed` before every load test run. Running
> `load-test.js` twice without re-seeding will show 0 successes — that is
> correct behaviour. All tickets sold out in the first run, and Redis correctly
> rejects all further requests instantly without touching the database.

---

## Issues Encountered During Development

### Issue 1 — BullMQ `maxRetriesPerRequest` Error
```
Error: BullMQ: Your redis options maxRetriesPerRequest must be null
```
**Root cause:** BullMQ uses blocking Redis commands (`BRPOPLPUSH`) internally
to wait for new jobs. These hold a connection open indefinitely. Passing a
regular ioredis client with `maxRetriesPerRequest: 3` is incompatible because
ioredis would interpret "still waiting" as a timeout failure and attempt retries,
completely breaking the blocking semantics BullMQ depends on.

**Fix:** Exported two separate things from `redis.ts`:
- `redisClient` — regular ioredis instance with `maxRetriesPerRequest: 3`
  for Lua scripts, GET, SET, and pipeline operations
- `bullMQRedisOptions` — plain config object with `maxRetriesPerRequest: null`
  that BullMQ uses to create its own managed internal connections

---

### Issue 2 — DB Consistency Mismatch After Load Test
```
EVENT001   Expected: 200   Actual: 5000   ⚠️ MISMATCH
```
**Root cause:** The BullMQ worker was inserting `issued_tickets` rows correctly
but was not calling `decrementAvailable()` to update `ticket_pools.available`
in PostgreSQL. The Redis counter was being decremented atomically (correct), but
the DB column was never updated, so the consistency check saw a mismatch between
`total - available` and actual row count.

**Fix:** Added `decrementAvailable()` inside the worker's transaction alongside
`bulkInsertTickets()`. Both now run atomically in one `BEGIN/COMMIT` block.

---

## Architecture

```
POST /purchase
      │
      ▼
 [Validator]           quantity % 8 === 0, fields present, types correct
      │
      ▼
 [Controller]          parse HTTP → call service → return HTTP response
      │
      ▼
 [TicketService]
      │
      ├── Redis ready? ──YES──► [Redis Lua Script]   atomic check+decrement
      │                                │
      │                         [BullMQ Queue]        enqueue persist job
      │                                │
      │                         ← return tickets to user (~1-5ms)
      │                                │
      │                         [BullMQ Worker]       background
      │                          BEGIN TRANSACTION
      │                          INSERT issued_tickets (bulk unnest)
      │                          UPDATE ticket_pools.available
      │                          COMMIT
      │
      └── Redis down? ──────► [PostgreSQL Transaction]
                               SELECT FOR UPDATE      row-level lock
                               INSERT issued_tickets  (bulk unnest)
                               UPDATE ticket_pools.available
                               COMMIT
                               ← return tickets to user (~10-50ms)
```

---

## Project Structure

```
src/
├── config/
│   ├── database.ts           PostgreSQL connection pool (singleton, max 20)
│   └── redis.ts              ioredis client + BullMQ connection options
├── controllers/
│   └── ticketController.ts   HTTP only — no business logic
├── services/
│   └── ticketService.ts      Core logic — Redis path + DB fallback + sync
├── repositories/
│   └── ticketRepository.ts   Raw SQL — FOR UPDATE, bulk INSERT via unnest, UPDATE
├── queue/
│   └── ticketQueue.ts        BullMQ queue — 5 retries, exponential backoff
├── workers/
│   └── ticketWorker.ts       Async DB persistence — concurrency 10
├── middleware/
│   └── errorHandler.ts       Global 500 + 404 handlers
├── validators/
│   └── purchaseValidator.ts  Input validation
├── types/
│   └── index.ts              Shared TypeScript interfaces
├── server.ts                 Express app + startup bootstrap + Redis sync
└── seed.ts                   Seeds PostgreSQL + Redis atomically
```

---

## New Dependencies

| Package | Why |
|---------|-----|
| `ioredis` | Production-grade Redis client with auto-reconnect, pipelining, Lua script support, and cluster mode. The de-facto standard for Node.js Redis in production. |
| `bullmq` | Redis-backed job queue. Provides at-least-once delivery, automatic retries with configurable backoff, job acknowledgment, and worker concurrency — all critical for reliable async DB writes. |

---

## API

### `POST /purchase`
```json
Request:  { "userId": "string", "eventId": "string", "quantity": 8 }
Success:  { "success": true, "tickets": [1, 2, 3, 4, 5, 6, 7, 8] }
Error:    { "success": false, "error": "Not enough tickets available" }
```
- `quantity` must be a positive integer and a multiple of 8

### `GET /health`
Returns `{ "status": "ok" }` — used for load balancer health probes.
