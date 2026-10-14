-- Moves an existing database from embedding classification to OpenAI tags.
-- Fresh installs don't need this: db/init.sql already has the new schema.
--   psql -U status -d status_db -f db/migrations/002_tags.sql
BEGIN;

ALTER TABLE statuses ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

-- Keep each status's old category as its first tag (the ids match data/tags.json).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'statuses' AND column_name = 'category') THEN
    UPDATE statuses SET tags = ARRAY[category]
     WHERE category IS NOT NULL AND category <> 'other' AND tags = '{}';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_statuses_category_exp;
DROP INDEX IF EXISTS idx_statuses_embedding;
ALTER TABLE statuses
  DROP COLUMN IF EXISTS embedding,
  DROP COLUMN IF EXISTS category,
  DROP COLUMN IF EXISTS confidence,
  DROP COLUMN IF EXISTS classified_by;
CREATE INDEX IF NOT EXISTS idx_statuses_tags ON statuses USING gin (tags);

COMMIT;
