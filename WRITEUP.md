# Bugs , Fixes , Arcitectural Decisions & Trade Offs

So ,there are 2 bugs

1) Producing same ticket Number **(duplicates)**
2) Allotting more seats than allocated which results in negative - **TOCTOU race condition**

Root Cause for both the bugs is same, which is , the sql operations & code level checks are **neither transactional nor locked i.e, they are not atomic** . So when multiple users hit the buy/book button they read the same value & Since there's no lock , data would be inaccurate and inconsistent leading multiple users to have Same ticket numbers & allotting more seats than available.

Among Various options like **Application-Level Mutex, Optimistic Locking with Version Column etc** I chose PostgreSQL **SELECT FOR UPDATE** as basic fix and  **Redis Lua Script + BullMQ Async** Queue for scalable fix .

**Why I rejected below 2 approaches:**

**Application Level Mutex** : In memory lock would be good if there's only one instance. If there are multiple instances , each doing their own work without any communication/acknowledgement , this would lead to race condition again.

**Optimistic Locking with Version Column :** In real time out of 1000's of request of only one would succeed , rest of them would lead to retry storms leading to unnecessary db hits and exhausting the resources

**Fixes :**

I have implemented both Redis Lua Script + BullMQ Async Queue  & PostgreSQL SELECT FOR UPDATE approaches , when redis status is not ready then I've used select for update as fallback mechanism. Domain errors  like Event not found, Not enough tickets are not falling back to DB, they're thrown immediately. Only infrastructure errors (Redis crash, Lua execution error) trigger the DB fallback.

**PostgreSQL SELECT FOR UPDATE as basic fix**
When user A tries to book a ticket/ reads available tickets , lock is acquired on entire row . User B can only proceed after completion of A's transaction so that user B would read newly updated values.

**TradeOffs :**
This would be efficient when traffic is low , because it would take short time for locking the row & does the operations efficiently . But at very high scale with multiple server instances, all requests converge on a single DB row lock, which becomes a serialisation bottleneck

**Redis Lua Script + BullMQ Async Queue for scalable fix:**
Redis Lua script can do the operation atomically , even though there 4-5 commands inside the script , they are considered as "one" command only and it runs in a single thread. It's 50x times faster when compared to PostgreSQL (0.1ms for redis , 5-20ms for PostgreSQL) .

Redis guarantees the ticket numbers are unique , even though redis has single instance across multiple servers , data is accurate and there's no chance of duplicate ticket number generation.
Lua script uses INCRBY on the issued counter and returns the starting number. Because INCRBY is atomic and sequential, Request A gets `issued_count = 8` → returns 1, Request B gets `issued_count = 16` → returns 9. Mathematically non-overlapping ranges.

**Asynchronous DB Operations :**

Instead of waiting for db operations , Users can instantly get their ticket numbers
Ex : User A gets tickets from 1 to 8 , User B gets from 9 to 16 ....etc

Here, each transaction is considered as job and this job is pushed by redid into BULLMQ queue : "ticket-persist" ,

Ex : Job1 : {userId : 1, eventId : 1, tickets [] = {1,2,3,4,5,6,7,8}}

So, I have implemented a worker which listens continuously for the jobs & process it asynchronously and at max it would insert data of 10 users concurrently .

**What if the worker fails?** BullMQ keeps the job in the queue and retries with exponential backoff: waits 500ms, then 1s, then 2s, then 4s, then 8s. After 5 attempts it marks the job as permanently failed for manual inspection. The user already has their tickets. The DB will eventually catch up.
The worker runs both `bulkInsertTickets` & `decrementAvailable` inside one single PostgreSQL transaction maintaining atomicity.

**Note :** 

1) Previously there was a for loop for each insert , which resulted in  N separate INSERT queries = N database round-trips. I have modified it & used unnest for bulk insert . With `unnest()` it's 1 query regardless of quantity
2) And I've also added below constraints at the db level  as a last line of defence . Even if.  application logic has a bug, the database rejects the offending write with a constraint violation rather than silently corrupting data

```sql
UNIQUE (event_id, ticket_number) for issued_tickets table
available_non_negative CHECK (available >= 0) for tickes_pool table
```

**The data is consistent & accurate ,because of these 2 things**

1 ) **Redis AOF Persistence :** Append-Only-File contains all write operations executed by redis . So even when redis server is down & restarted , it reads those logs and maintains the exact data which is needed at the moment . I've added these commands in docker - compose  file . The log file is preserved even when redis container is destroyed.
**docker-compose.yml**
redis:
command: redis-server --appendonly yes
volumes:
- redis_data:/data

2 ) **syncAllEventsToRedis in server.ts file**
whenever server is crashed, restarted, manually flushed the next server startup will re-populate Redis with the correct values from PostgreSQL.
