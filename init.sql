CREATE TABLE IF NOT EXISTS ticket_pools (
    event_id  VARCHAR(50) PRIMARY KEY,
    total     INTEGER NOT NULL,
    available INTEGER NOT NULL,
    -- Prevent available from going negative at DB level — last line of defence
    CONSTRAINT available_non_negative CHECK (available >= 0)
);

CREATE TABLE IF NOT EXISTS issued_tickets (
    id            SERIAL PRIMARY KEY,
    event_id      VARCHAR(50) NOT NULL,
    user_id       VARCHAR(50) NOT NULL,
    ticket_number INTEGER NOT NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Database-level uniqueness guarantee — even if application logic has a bug,
    -- the DB will reject duplicate (event_id, ticket_number) pairs outright.
    CONSTRAINT unique_ticket_per_event UNIQUE (event_id, ticket_number)
);

-- Index for fast lookups by event
CREATE INDEX IF NOT EXISTS idx_issued_tickets_event_id ON issued_tickets (event_id);