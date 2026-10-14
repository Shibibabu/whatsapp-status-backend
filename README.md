# WhatsApp-style Status Backend

NestJS backend for 24-hour text statuses. OpenAI tags every status (category,
type, topics, mood), and each user saves a feed filter, such as "cricket" or
"laptops for sale", that is applied every time they load their feed. Updates
reach the browser in real time.

The UI lives in the sibling project `../whatsapp-status-frontend` (React + Vite).

For how it works inside (components, data model and every flow), see
**[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Prerequisites

| Tool | Version | Used for |
|---|---|---|
| Node.js | 20+ | backend and frontend |
| PostgreSQL | 14+ (17 tested) | users, contacts, statuses, saved filters |
| Redis | 6+ | BullMQ job queue for background tagging |
| OpenAI API key | with credits | tagging statuses and searches |
| `jq` | any | only for `scripts/seed-demo.sh` |

A ChatGPT subscription does not include API credits. Add credits at
https://platform.openai.com/settings/organization/billing/.

## Setup

### 1. Start Postgres and Redis

**Option A: Docker**

```bash
docker compose up -d
```

This starts Postgres on `5432` (user/password/db: `status`/`status`/`status_db`)
and Redis on `6379`. `db/init.sql` runs automatically the first time.

**Option B: Homebrew (macOS)**

```bash
brew install postgresql@17 redis
brew services start postgresql@17
brew services start redis
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

createuser -s status
psql -d postgres -c "ALTER USER status PASSWORD 'status'"
createdb -O status status_db
psql -U status -d status_db -f db/init.sql
```

### 2. Configure

```bash
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env`. The other defaults match the setup above.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | | Postgres connection string |
| `REDIS_HOST` / `REDIS_PORT` | `localhost` / `6379` | BullMQ queue |
| `OPENAI_API_KEY` | | **Required.** Without it, new statuses end in `state: "failed"` |
| `OPENAI_MODEL` | `gpt-5.4-mini` | Model used for tagging and search matching |
| `TAGS_FILE` | `data/tags.json` | The shared tag list (read at startup, appended as tags are learned) |

### 3. Run the backend

```bash
npm install
npm run start:dev        # http://localhost:3000, restarts on code changes
```

You should see `Loaded N tags from .../data/tags.json` in the log.

### 4. Run the frontend

```bash
cd ../whatsapp-status-frontend
npm install
npm run dev              # http://localhost:5173
```

The Vite dev server proxies `/api/*` to `http://localhost:3000`, so no CORS
setup is needed.

### 5. Demo data (optional)

With the backend running:

```bash
./scripts/seed-demo.sh
```

This creates five users with statuses. Log in to the frontend with phone
`+910000000000` ("You"), who has all of them as contacts. Tagging takes a few
seconds per status.

### Upgrading an existing database

`db/init.sql` always has the full current schema, for fresh installs. For a
database created earlier, run the migrations you haven't run yet, in order:

```bash
psql -U status -d status_db -f db/migrations/002_tags.sql          # embeddings -> tags
psql -U status -d status_db -f db/migrations/003_feed_filters.sql  # saved feed filters
```

## Scripts

| Command | What it does |
|---|---|
| `npm run start:dev` | Run with watch mode |
| `npm run build` | Compile to `dist/` |
| `npm run start:prod` | Run the compiled app (`node dist/main`) |
| `npm run typecheck` | TypeScript check without emitting |
| `node scripts/retag-statuses.mjs` | Re-tag live statuses that were never tagged by OpenAI (0-1 tags) or failed. `--all` re-tags every live status (e.g. after changing the prompt); or pass status ids. Needs the backend running. |
| `./scripts/seed-demo.sh` | Demo users and statuses |

## API

Auth is a placeholder: send `x-user-id: <uuid>` on every request except
registration and login. Replace `src/common/auth.guard.ts` with JWT/OTP before
production.

| Method | Path | Notes |
|---|---|---|
| POST | `/users` | `{ phone, name }` → creates a user |
| POST | `/users/login` | `{ phone }` → existing user (no OTP yet) |
| GET | `/users/me` | |
| POST | `/contacts` | `{ phone }`: you will see that person's statuses |
| GET | `/contacts` | |
| DELETE | `/contacts/:contactId` | |
| GET | `/tags` | every tag: `{ id, group, label, description }` |
| POST | `/statuses` | `{ text, bgColor? }` → `202`, `state: "pending"`; tagged in the background |
| GET | `/statuses/mine` | your live statuses with tags and view counts |
| GET | `/statuses/:id` | one of your statuses |
| DELETE | `/statuses/:id` | owner only |
| GET | `/statuses/feed` | contacts' live statuses, **your saved filter applied**. With a search, each status has `relevance` (0-1) and the best matches come first; `?limit=50` |
| GET | `/statuses/filter` | your saved filter: `{ query, concepts, tags, match }`; `concepts` are weighted tags, e.g. `[[{"id":"birthday","weight":1},{"id":"celebration","weight":0.4}]]` |
| PUT | `/statuses/filter` | `{ query?, tags?, match? }` replaces it; `{}` means "All". A new `query` is mapped onto tags (new tags are learned). Returns the filter plus `createdTags` |
| POST | `/statuses/:id/view` | mark a contact's status as seen |
| GET | `/statuses/:id/viewers` | owner only |
| GET | `/statuses/stream` | Server-Sent Events; `?userId=` works instead of the header |

### Try it with curl

```bash
H='content-type: application/json'
A=$(curl -s localhost:3000/users -H "$H" -d '{"phone":"+911111111111","name":"Asha"}' | jq -r .id)
B=$(curl -s localhost:3000/users -H "$H" -d '{"phone":"+922222222222","name":"Bilal"}' | jq -r .id)

# Bilal saves Asha as a contact
curl -s localhost:3000/contacts -H "x-user-id: $B" -H "$H" -d '{"phone":"+911111111111"}'

# Asha posts
curl -s localhost:3000/statuses -H "x-user-id: $A" -H "$H" -d '{"text":"India won by 5 wickets 🏏"}'
curl -s localhost:3000/statuses -H "x-user-id: $A" -H "$H" -d '{"text":"MacBook Pro for sale, 60k"}'
sleep 5   # tagging runs in the background

# Bilal only wants things for sale; the filter is saved and applied from now on
curl -s -X PUT localhost:3000/statuses/filter -H "x-user-id: $B" -H "$H" -d '{"query":"items for sale"}'
curl -s localhost:3000/statuses/feed -H "x-user-id: $B" | jq '.[].text'

# Back to everything
curl -s -X PUT localhost:3000/statuses/filter -H "x-user-id: $B" -H "$H" -d '{}'

# Watch live events
curl -N "localhost:3000/statuses/stream?userId=$B"
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Statuses stay `failed`, log says `429 You have no credits` | Add credits to the OpenAI account |
| Log says `OPENAI_API_KEY is not set` | Set it in `.env` and restart |
| `401` / `404` from OpenAI in the log | Wrong key, or no access to `OPENAI_MODEL` |
| Statuses stay `pending` | Redis isn't running, or the app crashed; check `redis-cli ping` |
| `Connection refused` on 5432 | Start Postgres (`brew services start postgresql@17` or `docker compose up -d`) |
| A contact's status isn't in your feed | They must be in **your** contacts, posted within 24h, and have an *exact* tag for your saved search (click **All** to clear it) |
| Old statuses have only one tag | They predate OpenAI tagging: run `node scripts/retag-statuses.mjs` |
| Edited `data/tags.json` but nothing changed | Tags are loaded at startup: restart the backend |
