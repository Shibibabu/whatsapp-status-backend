#!/usr/bin/env node
// Re-queues live statuses for OpenAI tagging. The running app's worker does the work,
// so the backend must be running (it owns data/tags.json).
//
//   node scripts/retag-statuses.mjs            # statuses never tagged by OpenAI (0-1 tags) or failed
//   node scripts/retag-statuses.mjs --all      # every live status (e.g. after changing the prompt)
//   node scripts/retag-statuses.mjs <id> ...   # specific statuses
//
// Re-tagging replaces a status's tags.
import 'dotenv/config';
import { Queue } from 'bullmq';
import pg from 'pg';

const args = process.argv.slice(2);
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

let rows;
if (args.includes('--all')) {
  ({ rows } = await db.query(`SELECT id, text FROM statuses WHERE expires_at > now()`));
} else if (args.length) {
  ({ rows } = await db.query(`SELECT id, text FROM statuses WHERE id = ANY($1::uuid[])`, [args]));
} else {
  ({ rows } = await db.query(
    `SELECT id, text FROM statuses
      WHERE expires_at > now() AND (state = 'failed' OR (state = 'classified' AND cardinality(tags) <= 1))`,
  ));
}

const queue = new Queue('status-classification', {
  connection: { host: process.env.REDIS_HOST ?? 'localhost', port: Number(process.env.REDIS_PORT ?? 6379) },
});
for (const { id, text } of rows) {
  // A fresh job id: the original job (id = status id) may still be kept as completed.
  await queue.add('classify', { statusId: id }, {
    jobId: `${id}-retag-${Date.now()}`,
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });
  console.log(`queued  ${id}  ${text.slice(0, 60)}`);
}
console.log(`${rows.length} status(es) queued; tags update in a few seconds (watch the app log).`);

await queue.close();
await db.end();
