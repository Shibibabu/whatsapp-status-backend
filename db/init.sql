CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       VARCHAR(20) NOT NULL UNIQUE,
  name        VARCHAR(80) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- user_id has saved contact_id; user_id can see contact_id's statuses
CREATE TABLE IF NOT EXISTS contacts (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, contact_id),
  CHECK (user_id <> contact_id)
);

DO $$ BEGIN
  CREATE TYPE status_state AS ENUM ('pending', 'classified', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS statuses (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text               VARCHAR(700) NOT NULL,
  bg_color           VARCHAR(7) NOT NULL DEFAULT '#075E54',
  tags               TEXT[] NOT NULL DEFAULT '{}',  -- tag ids from data/tags.json
  state              status_state NOT NULL DEFAULT 'pending',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX IF NOT EXISTS idx_statuses_user_exp     ON statuses (user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_statuses_tags        ON statuses USING gin (tags);

CREATE TABLE IF NOT EXISTS status_views (
  status_id  UUID NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
  viewer_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (status_id, viewer_id)
);

-- Each user's saved feed filter, applied every time their feed is fetched.
CREATE TABLE IF NOT EXISTS feed_filters (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  query       VARCHAR(200) NOT NULL DEFAULT '',  -- what the user typed, e.g. "laptops for sale"
  concepts    JSONB NOT NULL DEFAULT '[]',       -- query resolved to tag ids, one array per concept
  tags        TEXT[] NOT NULL DEFAULT '{}',      -- tag chips picked directly
  match       VARCHAR(3) NOT NULL DEFAULT 'any', -- chips: 'any' or 'all'
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
