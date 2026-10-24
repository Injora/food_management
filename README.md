# Hack Day Ops: hackathon registration desk

Volunteer dashboard for running a hackathon desk: registration import, participant-level check-in, lunch/snacks/dinner coupons, and room allocation for the open-source talks (24 Oct, 12:00–13:30) and the hackathon (24 Oct 16:00 – 25 Oct 04:00). Every count comes from PostgreSQL, and the rules that matter (one coupon per person per meal, no room over its limit, no duplicate check-ins) are enforced by the database, not just the screen.

**Stack:** Next.js 16 (App Router, TypeScript), Tailwind CSS 4, shadcn/ui (Base UI), PostgreSQL on **Neon** via Drizzle ORM + `pg`, Zod, Papa Parse, read-excel-file, Sonner, Vitest.

---

## Quick start

```bash
pnpm install
cp .env.example .env.local   # fill in DATABASE_URL (+ _UNPOOLED), ADMIN_*, TEST_DATABASE_URL
pnpm db:migrate              # apply ./drizzle migrations (uses DATABASE_URL_UNPOOLED if set)
pnpm db:seed                 # create the first admin from ADMIN_EMAIL / ADMIN_PASSWORD
pnpm dev                     # http://localhost:3000
```

Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, then add volunteer accounts under **Volunteers**.

| Command | Purpose |
|---|---|
| `pnpm db:migrate` / `pnpm db:seed` | Schema migrations / first admin (never seeds registrations) |
| `pnpm import:check <file>…` | Dry-run the importer on local CSV/XLSX files (no database) |
| `pnpm import:registrations <file>… [--commit] [--update]` | Import through the same service as the UI (dry run unless `--commit`) |
| `pnpm user:create --email … --name … --role organizer --password …` | Create/reset an account (`organizer` = volunteer) |
| `pnpm test` / `pnpm lint` / `pnpm typecheck` / `pnpm build` | Checks |

### Environment variables

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Neon **pooled** endpoint (`…-pooler…`), `sslmode=verify-full`. Server-only. |
| `DATABASE_URL_UNPOOLED` | Neon direct endpoint, used by `db:migrate`. |
| `NEXT_PUBLIC_EVENT_TIMEZONE` | Default `Asia/Kolkata`. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | First admin (password ≥ 10 chars). |
| `TEST_DATABASE_URL` | Throwaway database for integration tests (the suite drops its schema). Must differ from `DATABASE_URL`. |

The Neon project for this event is `hackathon-ops` (`damp-lab-74519173`, branch `main`, ap-southeast-1). `.env*` and root `*.csv` files are git-ignored: registration files contain personal data.

---

## Pages

| Page | What volunteers do there |
|---|---|
| **Overview** `/` | Summary cards (teams, participants, checked in, full/partial/none, coupons per meal, talk/hackathon occupancy), alerts, room bars, recent activity. |
| **Check-in** `/check-in` | Type → ↑/↓ → Enter. Tick each person who is present (or press 1–9). "Check in entire team" (or `A`) is explicit and confirmed. Untick to undo (confirmed, audited). Opening a team never marks anyone present. |
| **Food coupons** `/coupons?meal=` | Per meal: issued/entitled, teams pending. "+1" issues to the next member (present members first); "Issue all N" is confirmed. |
| **Open-source talks / Hackathon rooms** `/rooms/talks`, `/rooms/hackathon` | Search team → members (present preselected) → room (preview shows fits / uses tolerance / no space) → allocate. Live room cards and teams-by-room table with Move / Release. |
| **Teams** `/teams` | One row per team: name, leader, size, check-in, lunch/snack/dinner, talk room, hackathon room, actions. Search by team, leader, member, email, phone; filters for check-in, rooms and pending coupons; sort; pagination. All state lives in the URL. Clicking a team opens the **team panel** (check-in, coupon grid, rooms for both sessions, member management, history). |
| **Registration import** `/import` (admin) | Upload → preview → mapping → validate against the database → review issues and teams → import. |
| **Reports** `/reports` (admin) | CSV downloads (see below) and summary tables. |
| **Settings** `/settings` (admin) | Session times, per-session tolerance, room capacities/tolerance, add/remove rooms. |
| **Volunteers** `/admin/users` (admin) | Accounts and roles. |

Screens poll `/api/board` every 4 s while visible and refetch right after every action. Polling was chosen over push because there is no real-time infrastructure and it keeps the server stateless; the trade-off is up to ~4 s lag between desks. A stale screen can never over-issue or overfill: the server re-checks inside a transaction and the screen shows the refusal.

## Roles

| | Admin | Volunteer (`organizer`) |
|---|:-:|:-:|
| Check in / undo check-in, issue coupons, allocate / move / release rooms | ✓ | ✓ |
| Revert a coupon (reason required) | ✓ | |
| Import registrations, register walk-in teams, edit/withdraw members, archive/delete teams | ✓ | |
| Room capacities, tolerance, session times | ✓ | |
| Reports & exports, audit log, accounts | ✓ | |

Permissions are enforced in every service function (`assertPermission`); hiding links is cosmetic.

---

## Data model (`src/db/schema.ts`, migration `drizzle/0002_participants_rooms.sql`)

| Table | Integrity |
|---|---|
| `teams` | `team_code` unique; `registration_key` unique (team name + leader email/phone/name, or file team code) so re-imports never duplicate; names are **not** unique (two different "Commitment Issues" teams exist). Archived, never silently deleted. |
| `participants` | Stable id `P-0001` (identity column); `UNIQUE(team_id, identity_key)`; one active leader per team (partial unique index); `UNIQUE(id, team_id)` as the target of composite FKs; withdrawn members keep their history. |
| `check_ins` | Composite FK `(participant_id, team_id)` → participants, so a check-in can't point at the wrong team. Partial unique index: one live check-in per participant. Undo keeps the row (`undone_at/by/reason`). |
| `coupon_issuances` | One row per coupon (team, participant, meal, time, volunteer, request id). Partial unique index on `(participant_id, coupon_type) WHERE reverted_at IS NULL`: an entitlement can't be used twice, whatever the client does. Reversal keeps the row. |
| `event_sessions`, `rooms` | Sessions `talks` / `hackathon`; rooms per session with `nominal_capacity`, `overflow_tolerance` (default 3) and `occupancy`. **`CHECK (occupancy <= nominal_capacity + overflow_tolerance)`**. |
| `team_room_assignments` | `UNIQUE(session_id, team_id)`: a team is in one room per session. FK `(room_id, session_id)` → rooms, so a hackathon room can't be used for talks. |
| `room_allocations` | One row per seated participant. `UNIQUE(session_id, participant_id)`: never two rooms in one session, free to be in any room in the other session. FKs pin the participant to its team and the seat to the team's room. A trigger keeps `rooms.occupancy` in sync on every insert/delete/move. |
| `registration_imports`, `audit_logs` | Import summaries/issues; every operational change is audited (actor, before/after, details) in the same transaction. |
| `users`, `sessions` | Auth (scrypt passwords, hashed session tokens). |

The migration is incremental: data from the previous team-level meal model is preserved (legacy team fields move to `teams.source`, old audit rows keep their meal in `details`).

### Capacity: concurrency-safe, participant-based, ±3 tolerance

`allowed ⇔ current occupancy + incoming participants ≤ nominal capacity + tolerance` (`src/lib/capacity.ts`). An allocation/move transaction:

1. locks the team row, then the affected room rows `FOR UPDATE` in id order (no deadlocks);
2. checks the rule against the locked occupancy; if it fails, returns `CAPACITY_EXCEEDED` with occupancy, remaining slots, the effective maximum and alternative rooms (rooms with nominal space first, then rooms that would need the tolerance);
3. writes participant rows; the trigger updates occupancy and the `CHECK` constraint makes it impossible to commit a room over its limit, even for code that bypasses the service.

Reassignment releases the old seats and takes the new ones in one transaction; a rejected move leaves everything unchanged. Capacity/tolerance changes are refused if a room already holds more than the new limit, so an overflow can't be hidden. Rooms above nominal (within tolerance) show a red "Over nominal — using tolerance" state; at the limit they show "FULL".

### Coupons and check-in

Entitlement = active registered members × {lunch, snacks, dinner}. Issuing (one member, next pending, or all pending) inserts one row per person under the team lock; double clicks, retries (same `requestId` is replayed) and concurrent volunteers can't produce a second coupon. Check-in status is derived: `0/N` not checked in, `1..N-1/N` partial, `N/N` full.

## Registration import

`src/lib/registration-import.ts` (pure, shared by browser preview, server and CLI) + `src/server/services/import.ts`.

- CSV or `.xlsx` (sheet picker for workbooks). Header row optional: preamble lines ("We have to add this teams") are skipped and reported; without a header, columns are inferred from contents (team name, counts, leader name + contact columns, college, repeating member name/email/phone groups).
- Layouts: one row per team (leader + numbered member columns) or one row per participant (grouped by team code, leader or name; leader by role column or leader columns). Status values like `cancelled` are excluded.
- Reports: missing/placeholder team names (imported as "Unnamed team – Leader"), missing leaders, malformed rows, size column vs listed members (the **listed** members are imported; nobody is invented), exact duplicate rows (merged), conflicting duplicates, same team name with different leaders (kept separate, distinct codes), the same participant in two teams, and conflicts with teams already in the database.
- Validate runs the full analysis server-side; Import re-runs it inside one transaction under an advisory lock, so a failure writes nothing. A downloadable CSV report lists every issue.
- Re-import: "Add new teams only" or "Add new and update existing". Matching is by registration key (or leader contact when a team was renamed); members match by external id, email, phone, then name, so the **same participant record** keeps its check-ins, coupons and seats. Imports never touch check-ins, coupons or allocations and never remove members (members missing from the file are reported and kept).

### The supplied files (imported into Neon on 24 Oct)

| File | Layout detected | Teams | Participants | Flags |
|---|---|---:|---:|---|
| `Hack Day Team - Sheet11.csv` | header, team rows | 97 | 282 | 2 placeholder team names ("(no team name given)", "none") |
| `Hack Day Team - Sheet10.csv` | no header + preamble, leader phone before email | 14 | 50 | "3 Brain Cells": size column says 4, 3 listed; "Registered Members" column differs from listed members on all 14 rows (info); **Pruthviraj Gojare** is in both *Bisleri* and *The Safari*; a second, different **Commitment Issues** (leader Anushka) imported as `COMMITMENT-ISSUES-2` |

Total: **111 teams, 332 participants**. Re-importing either file is a no-op.

## Reports (`/api/export/[kind]`, admin)

`registrations`, `attendance?status=present|absent`, `team-checkins?status=full|partial|none`, `coupons[?meal=lunch|snacks|dinner]` (every transaction incl. reversals), `coupon-summary`, `allocations?session=talks|hackathon`, `occupancy`, `audit`. Generated from the database at download time, UTF-8 BOM for Excel, spreadsheet formulas neutralised.

## Tests

```bash
pnpm test
```

- **Unit** (`tests/unit`): the tolerance decision table (59+4 allow, 60+3 allow, 61+3 reject, 57+5 allow, 40+4 reject), room levels and suggestion order, check-in status, both import layouts with and without header, duplicate/malformed/placeholder detection, permissions, CSV escaping, password hashing; plus the two real registration files when present locally.
- **Integration against real PostgreSQL** (`tests/integration`, needs `TEST_DATABASE_URL`): full and partial check-in, undo, duplicate check-ins under concurrency; independent lunch/snacks/dinner, duplicate and over-issuance prevention, 10 concurrent volunteers → one issuance, replay, admin-only reversal; allocation that fits, rejection with error text and alternatives, tolerance cases, present-only allocation, reassignment occupancy, **12 concurrent teams racing for one room never exceed it**, DB `CHECK` backstop, talks/hackathon independence; import of all layouts, duplicate detection vs DB, re-import preserving operational records, transactional rollback on a mid-import failure; attendance/coupon/occupancy reports; auth and role checks.

If `TEST_DATABASE_URL` is unset the integration suites are skipped (reported as skipped, not passed).

## Limitations

- Live updates are polling (≈4 s), not push.
- No login rate limiting in the app: add a Vercel Firewall rule on `POST /login` or Deployment Protection when deploying.
- Session times in Settings are entered in the browser's time zone.
- Volunteers can undo check-ins (audited); coupon reversal is admin-only.
- By design a team sits in one room per session; splitting a team across rooms is not supported.
