-- Each user's saved feed filter, applied every time their feed is fetched.
--   psql -U status -d status_db -f db/migrations/003_feed_filters.sql
CREATE TABLE IF NOT EXISTS feed_filters (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  query       VARCHAR(200) NOT NULL DEFAULT '',  -- what the user typed, e.g. "laptops for sale"
  concepts    JSONB NOT NULL DEFAULT '[]',       -- query resolved to tag ids, one array per concept
  tags        TEXT[] NOT NULL DEFAULT '{}',      -- tag chips picked directly
  match       VARCHAR(3) NOT NULL DEFAULT 'any', -- chips: 'any' or 'all'
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
