# Food Desk: hackathon meal coupon distribution

An organizer dashboard for handing out breakfast, lunch and dinner coupons at a hackathon. Organizers search for a team, see the exact coupon count, confirm, and the server records the issuance. The database guarantees each team gets each meal at most once, even with several organizers working at the same time.

**Stack:** Next.js 16 (App Router, TypeScript), Tailwind CSS 4, shadcn/ui (Base UI), PostgreSQL (Neon) via Drizzle ORM and `pg`, Zod, Papa Parse, Lucide, Sonner, Vitest.

---

## Quick start (local)

Requirements: Node.js ≥ 22, pnpm, and PostgreSQL (local, Docker, or a Neon branch).

```bash
pnpm install
cp .env.example .env.local        # then edit the values below
createdb food_management          # or point DATABASE_URL at a Neon branch
pnpm db:migrate                   # apply migrations in ./drizzle
pnpm db:seed:sample               # admin from ADMIN_* env + demo organizer + 24 sample teams
pnpm dev                          # http://localhost:3000
```

Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env.local`. The sample seed also creates `organizer@example.com` with password `organizer-password`. That account is for local use only, so don't run `db:seed:sample` against production.

| Command | Purpose |
|---|---|
| `pnpm db:migrate` | Apply SQL migrations (uses `DATABASE_URL_UNPOOLED` if set, else `DATABASE_URL`) |
| `pnpm db:seed` | Create the first admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` (safe on production) |
| `pnpm db:seed:sample` | Same, plus a demo organizer and `samples/teams-sample.csv` (local only) |
| `pnpm db:setup` | `db:migrate` + `db:seed` |
| `pnpm user:create --email … --name … --role organizer --password …` | Create or reset a user from the CLI |
| `pnpm db:generate` | Generate a new migration after editing `src/db/schema.ts` |
| `pnpm test` / `pnpm lint` / `pnpm typecheck` / `pnpm build` | Checks |

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres URL. On Neon use the **pooled** endpoint (`…-pooler…`). Server-only, never exposed to the browser. |
| `DATABASE_URL_UNPOOLED` | recommended on Neon | Direct endpoint used only by `pnpm db:migrate`. |
| `NEXT_PUBLIC_EVENT_TIMEZONE` | no | IANA zone used for "issued today" and timestamps. Default `Asia/Kolkata`. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | for seeding | Used by `db:seed` / `user:create` only. Password ≥ 10 chars. |
| `TEST_DATABASE_URL` | for tests | A **throwaway** database; the test suite drops and recreates its schema. Must differ from `DATABASE_URL`. |

Secrets live in `.env.local` / Vercel env vars. `.env*` is git-ignored (except `.env.example`), and so are root-level `*.csv` files, because real registration exports contain participant PII.

---

## Connecting Neon

1. Create a Neon project (or add Neon from the Vercel Marketplace, which provisions it and injects the env vars).
2. Copy two connection strings from **Connection Details**:
   - pooled (host contains `-pooler`) → `DATABASE_URL`
   - direct → `DATABASE_URL_UNPOOLED`
   Both should include `?sslmode=require`.
3. From your machine, with those values in `.env.local`:
   ```bash
   pnpm db:migrate
   pnpm db:seed          # creates the first admin; NOT db:seed:sample
   ```

The app uses `node-postgres` with a small pool (`max: 5`) through Neon's PgBouncer endpoint and registers it with `attachDatabasePool` from `@vercel/functions`, so Fluid Compute closes idle connections cleanly. Interactive transactions (needed for issuance and imports) work over this connection.

## Deploying to Vercel

1. Push the repo to GitHub and import it in Vercel (framework preset: Next.js; build command `pnpm build`).
2. Under **Settings → Environment Variables**, set `DATABASE_URL`, `DATABASE_URL_UNPOOLED` and optionally `NEXT_PUBLIC_EVENT_TIMEZONE` for Production (and Preview, ideally on a separate Neon branch).
3. Run `pnpm db:migrate` and `pnpm db:seed` against the production database **before** the first deploy, and again (migrate) whenever `drizzle/` changes. Migrations are deliberately not run during the build.
4. Deploy. `GET /api/health` returns `{"ok":true,"database":"up"}` when the DB is reachable.
5. Recommended: add a Vercel Firewall rate-limit rule on `POST /login` (see Limitations).

---

## Authentication and permissions

Built-in email + password auth, with no external provider needed:

- Passwords are hashed with scrypt (`N=16384, r=8, p=1`, random salt).
- On login a random 256-bit token is set as an `httpOnly`, `SameSite=Lax` cookie (`Secure` in production). Only its SHA-256 hash is stored in the `sessions` table. Sessions last 7 days and are revoked when a user is disabled, their role changes, or their password is reset.
- `src/proxy.ts` only does an optimistic redirect to `/login`. **Authorization is enforced inside every service function** (`assertPermission`), so Server Actions, Route Handlers and scripts can't bypass it. Hiding a nav link is cosmetic.
- Server Actions get Next's built-in Origin/Host CSRF check; the `?next=` redirect only accepts same-site paths.

| Permission | Admin | Organizer |
|---|:-:|:-:|
| View dashboard, meal boards, teams and team history | ✓ | ✓ |
| Issue coupons | ✓ | ✓ |
| Import CSV, add/edit/delete teams, correct member counts | ✓ | |
| Revert issuance, adjust coupon quantity | ✓ | |
| Reports, CSV exports, full audit log | ✓ | |
| Manage organizer accounts | ✓ | |

Create the first admin with `pnpm db:seed`. Admins then add organizers at **Organizers** (`/admin/users`). At least one active admin is always kept, and an admin can't demote or disable themselves.

To use an external provider instead (Clerk, Auth0, etc.), replace `getActor()` in `src/server/auth/current.ts` so it returns `{ id, email, name, role }` for the signed-in user, mapped to a row in `users`. Everything downstream (services, audit `actor_id`, `issued_by`) keeps working.

---

## How it works

### Database (`src/db/schema.ts`, migrations in `drizzle/`)

| Table | Key points |
|---|---|
| `teams` | `team_code` unique; `team_name_key` (lower-case, letters/digits only) unique, so "Code-Pirates" and "code pirates" can't both exist; `CHECK member_count > 0` |
| `meals` | reference rows `breakfast`, `lunch`, `dinner` (seeded by migration `0001`), keyed by the `meal_type` enum |
| `distributions` | one row per team × meal: `UNIQUE (team_id, meal_type)`, `CHECK coupon_quantity > 0`, `CHECK (status = 'issued') = (issued_at IS NOT NULL)`, `issued_by` → users, `issue_request_id` for idempotent retries. `team_id` is `ON DELETE RESTRICT`. |
| `audit_logs` | actor id + email snapshot, action enum, team, meal, reason, `before` / `after` / `details` JSONB |
| `users`, `sessions` | auth (see above) |

Every new team gets three `pending` distribution rows with `coupon_quantity = member_count`, in the same transaction that creates the team.

### Issuing coupons (`src/server/services/distribution.ts`)

```sql
UPDATE distributions SET status='issued', issued_at=now(), issued_by=$actor, issue_request_id=$req
WHERE team_id=$team AND meal_type=$meal AND status='pending' AND coupon_quantity=$confirmedQty
RETURNING *;
```

- **Concurrency:** Postgres row locking means that when two organizers confirm at the same moment, exactly one `UPDATE` matches. The other matches zero rows and gets `ALREADY_ISSUED` with who issued it and when. (The test fires 10 simultaneous requests: 1 success, 9 rejections, 1 audit row.)
- **Idempotency:** each confirmation carries a client-generated `requestId`. A retry after a dropped connection with the same id returns the original success (`replayed: true`) instead of issuing again. Double clicks are also blocked client-side.
- **Stale screens:** the confirmed quantity must match the database. If an admin changed it in the meantime, the server returns `QUANTITY_CHANGED` and the dialog asks for confirmation again with the new number.
- Issuing one meal never touches the other two rows.

### Corrections (admin, reason required, always audited)

- **Revert issuance** puts a meal back to pending. The original issuance stays in the audit log.
- **Adjust coupon quantity** changes one meal's quantity (pending or issued), with before/after logged.
- **Edit team** can change the member count only while no meal is issued (`MEMBER_COUNT_LOCKED` otherwise). Pending quantities follow the new count.
- **Correct member count** works after issuance. Issued meals keep the quantity actually handed out; pending meals are updated (optional).
- **Delete team** is only allowed if nothing was issued.

Team edits lock the team's distribution rows `FOR UPDATE`, so an edit and an issuance can't interleave.

### CSV import (`src/lib/csv-import.ts`, `src/server/services/import.ts`)

1. The browser parses the file with Papa Parse, previews it, and auto-detects the mapping. Blank or duplicate headers, ragged rows, unbalanced quotes, empty files and files over 20 MB / 50k rows are reported.
2. The organizer adjusts the mapping. The team size can come from:
   - a **size column** (`member_count`, `Team Size`, …),
   - **member-name columns**, counting the non-blank, distinct names per row (e.g. `Team Leader Name`, `Team Member 2 Name` …), or
   - **one row per member**, counting distinct member ids (e.g. email) per team.
   Rows can be merged per team by name, code or leader email, and excluded by a column value (e.g. `status = canceled`, which is auto-selected).
3. **Validate** sends only the mapped columns to the server, which runs a dry run against the current database: new / update / unchanged / already exists / blocked, invalid rows with line numbers, duplicate names or codes in the file, and conflict warnings (e.g. a team's rows disagree on size; the largest is used). Teams can be unticked.
4. **Import** re-runs the whole analysis inside one transaction, under an advisory lock that serializes imports, so the preview is never trusted. Teams and their three meal rows are bulk-inserted in chunks. One `csv_import` audit entry is written, plus a `team_update` entry per updated team.
5. A final report is shown, and a CSV of issues can be downloaded.

Modes: **Add new teams only**, or **Add new and update existing**. Updates apply only to teams with no issued meal; others are reported as *blocked* and never silently changed. Re-importing the same file never duplicates teams. Codes generated from names (`Byte Builders` → `BYTE-BUILDERS`) never overwrite an existing code.

Checked against the real registration export in this folder (414 rows, one per registrant, team form repeated): auto-detection maps `Team Name`, the leader fields and the four member-name columns, excludes 7 canceled rows, and yields **181 teams / 592 participants**. It flags 2 rows with a blank team name and 19 teams whose rows disagree (different sizes or leaders) for review before import.

### Screens

- **Dashboard (`/`):** totals, coupons issued today, overall progress, and per-meal cards that separate *team* counts from *coupon* counts (remaining coupons are computed from quantities). Auto-refreshes every 15 s.
- **Breakfast / Lunch / Dinner (`/meals/[meal]`):** the counter screen. Search is instant and client-side, matching name, code, leader and email while ignoring case and punctuation. Filters (All / Pending / Issued), sort, pagination, a large Issue button, and a confirmation dialog with the exact quantity. Keyboard flow: `/` focus search → type → `↑`/`↓` → `Enter` opens confirm → `Enter` issues. The list syncs with other organizers every 8 s and shows an offline indicator.
- **Teams (`/teams`, `/teams/[id]`):** all teams with per-meal status; detail page with meal states, admin corrections, and the team's full history.
- **CSV Import (`/import`)**, **Reports (`/reports`)** with per-meal table, team collection matrix, audit log and CSV exports (all teams, each meal's issuance, pending for a meal, audit log), and **Organizers (`/admin/users`)**.

Exports are generated from the database at request time, prefixed with a UTF-8 BOM for Excel, and neutralize spreadsheet formulas (`=`, `+`, `-`, `@`).

### Errors

Services throw typed `AppError`s (`VALIDATION`, `NOT_FOUND`, `ALREADY_ISSUED`, `QUANTITY_CHANGED`, `MEMBER_COUNT_LOCKED`, `CONFLICT`, `UNAUTHORIZED`, `FORBIDDEN`, …). Actions and API routes return `{ ok: true, data } | { ok: false, error: { code, message } }`. Database connection failures become `DB_UNAVAILABLE` ("nothing was saved"), and unexpected errors are logged and reported as failures, never as success. A network drop during issuance is shown as "unknown outcome, retry is safe".

---

## Tests

```bash
pnpm test
```

- **Unit** (`tests/unit`): CSV parsing and mapping (valid file, invalid counts, duplicates, member-column and per-member modes, conflict warnings, config errors), CSV export escaping, permission matrix, password hashing.
- **Integration against real PostgreSQL** (`tests/integration`, needs `TEST_DATABASE_URL`): import + meal initialization, dry run, duplicate prevention, update before issuance, blocked update after issuance, registration-export import, deselection; issuing breakfast without affecting lunch/dinner; lunch quantity = member count; duplicate rejection; idempotent replay; **10 concurrent requests → exactly 1 success**; stale quantity; revert and adjust with audit; DB constraints; member-count lock and correction; report and export accuracy (including "today" boundaries); unauthenticated and organizer-forbidden calls on every protected operation; session validation, expiry and revocation; last-admin protection.

The global setup rebuilds the test schema from the migrations. If `TEST_DATABASE_URL` is unset, the integration suites are **skipped** with a warning, not reported as passing.

---

## Limitations and notes

- **No login rate limiting in the app.** Add a Vercel Firewall / WAF rate-limit rule for `POST /login`, or put the deployment behind Vercel Deployment Protection.
- Live updates use 8 s polling rather than push. The server is authoritative, so a stale screen can never double-issue; it just shows "already issued" on confirm.
- No self-service password reset by email. Admins reset passwords at `/admin/users` or with `pnpm user:create`.
- Team names must be unique after normalization. Two genuinely different teams with the same name need to be renamed (e.g. in the CSV) before import.
- When merged rows disagree on team size, the importer uses the largest and flags the team for review.
- Not-found pages are rendered correctly but are sent with HTTP 200 (the authenticated layout streams before the page decides it's a 404).
- The full audit export is capped at 100,000 entries per download.
