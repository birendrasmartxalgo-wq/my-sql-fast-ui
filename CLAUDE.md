# mysql-fast-ui

pgAdmin/TablePlus-style web console for **MySQL** — the local server out of the box, plus saved **multi-server connections** (direct host:port or SSH-tunnelled with a PEM key; credentials AES-256-GCM encrypted at rest). Port from `.env` `PORT` (default **4602**). Bun built-ins only at runtime — `Bun.serve`, `Bun.SQL`, `Bun.spawn`, `bun:sqlite`, native `fetch` — no npm runtime deps. Modern neutral data-tool design (cool-gray surfaces, one MySQL-teal accent, 1px borders, dense grid; dark variant via token overrides under `html.dark`, persisted as `msq_dark` in localStorage). Tailwind 4 standalone binary (`tools/tailwindcss`) + self-hosted woff2 fonts (Inter UI, IBM Plex Mono data/SQL) + inline Lucide icons — zero runtime CDN. SQL editor is **CodeMirror 6, vendored** as `public/js/cm6.js` (built from `vendor/cm/entry.js` via `bun run cm`, MySQL dialect).

> Ported from the PostgreSQL tool `pg-admin-lite-v2`. The architecture is identical; this file documents only what differs for MySQL.

## The one Bun.SQL gotcha that matters

`Bun.SQL` picks its wire protocol from the **constructor form**:
- Object form `new SQL({hostname,...})` → **always PostgreSQL protocol**. Do not use it here.
- URL form `new SQL("mysql://user:pass@host:port/db")` → MySQL protocol. **This is the only way to speak MySQL.**
- Host must be `127.0.0.1`, **not `localhost`** (socket-path resolution fails).

`server/db.js` `getPool()` and `server/connections.js` `testConnection()` both build a `mysql://` URL. Keep it that way.

## Postgres → MySQL mapping (what was changed)

| Concept | Postgres | MySQL (here) |
|---|---|---|
| Identifier quoting | `"col"` | `` `col` `` (`quoteIdent`, client `qid`/`qi`) |
| Namespace | schema (`public`) inside a DB | **database is the namespace** — no schema layer; `currentDb` everywhere a schema was used |
| Introspection | `pg_catalog` / `pg_*` | `information_schema` (`TABLES`, `COLUMNS`, `KEY_COLUMN_USAGE`, `TABLE_CONSTRAINTS`) |
| Errors | SQLSTATE | MySQL `errno` (1054/1146/1062…) → `ERRNO_TEXT` in `server/query.js` |
| Plan | `EXPLAIN (FORMAT JSON)` | `EXPLAIN FORMAT=JSON` / `EXPLAIN ANALYZE`; `walkPlan` reads `query_block`/`access_type`/`using_filesort` |
| Table DDL | `pg_dump --schema-only -t` | `SHOW CREATE TABLE` + `SHOW INDEX` |
| Dump/restore CLI | `pg_dump`/`psql`/`pg_restore` | `mysqldump`/`mysql` client |
| Roles | `pg_roles` | `mysql.user` |
| CREATE DATABASE | `OWNER`/`TEMPLATE` | `CHARACTER SET`/`COLLATE` |
| DROP DATABASE | `WITH (FORCE)` | plain `DROP DATABASE` |
| Auto PK | `BIGSERIAL` / `GENERATED … IDENTITY` | `BIGINT AUTO_INCREMENT` |
| Types | `TIMESTAMPTZ`/`JSONB`/`UUID`/`BYTEA`/`TEXT` default | `DATETIME`/`TIMESTAMP`/`JSON`/`CHAR(36)`/`BLOB`/`VARCHAR(255)` default |
| `ALTER … TYPE … USING` | yes | `MODIFY COLUMN` (no USING) |
| `SET/DROP NOT NULL` | yes | re-state column via `MODIFY COLUMN col <type> [NOT] NULL` |
| `DROP INDEX x` | standalone | `ALTER TABLE t DROP INDEX x` |
| `gen_random_uuid()` | yes | `UUID()` |

There is **no maintenance-DB concept** — `server/connections.js` dropped the `maint_db` column; the maintenance DB for admin queries is just `mysql`.

## Layout (same shape as the PG tool)

- `server.js` — route dispatch, static serving, gzip. `/api/databases` uses `SHOW DATABASES` + `information_schema.SCHEMATA`; byte totals are `CAST(… AS UNSIGNED)`. `/api/tabledef` = `SHOW CREATE TABLE` + `SHOW INDEX`. `/api/export` = `mysqldump`, `/api/import` = `mysql` client.
- `server/db.js` — `Bun.SQL` pool cache keyed per connection+database; `quoteIdent` (backtick), `quoteLit` (backslash + `'` escaping), `validDbName` (≤64, no `/\ ` ``), MySQL-aware statement splitter (backtick strings, `#`/`-- `/`/* */` comments, `\` escapes — no PG dollar-quoting).
- `server/schema.js` — `fetchSchema`/`fetchFks` via `information_schema`; columns expose `extra` (for `auto_increment` detection in the insert modal). No schema layer — every table lives under its database.
- `server/query.js` — `ERRNO_TEXT` (MySQL errno → plain language), MySQL `EXPLAIN`, destructive-SQL guard.
- `server/connections.js`, `server/auth.js`, `server/store.js` (`data/mysql-fast.sqlite`), `server/ai.js` (Claude proxy, "MySQL expert" prompt) — otherwise as in the PG tool.
- `public/js/*.js` — plain `<script>` tags in dependency order; everything reads the editor through `window.CM`. `msq_*` localStorage keys, `?conn=` on every `api()` call.

## Build & run

```
bun start                # serve on $PORT (default 4602)
bun run dev              # --watch
bun run css              # rebuild public/assets/tw.css (after markup/JS class changes) — then bump ?v= in index.html
bun run cm               # rebuild public/js/cm6.js (after editing vendor/cm/entry.js)
```

`.env`: `MYSQL_HOST` (use `127.0.0.1`), `MYSQL_PORT` (3306), `MYSQL_USER` (root), `MYSQL_PASSWORD`, `MYSQL_MAINT_DB` (mysql), `ADMIN_PASSWORD`, `PORT`, optional `ANTHROPIC_API_KEY` + `AI_MODEL`.

## Cautions (unchanged from the PG tool)

- Single `.env` password gates **every** registered server. Don't weaken auth, don't add unauthenticated routes.
- Remote credentials/PEM keys are AES-256-GCM encrypted in `data/mysql-fast.sqlite` with `data/secret.key` — never echo decrypted secrets through any API; keep both out of git.
- `ANTHROPIC_API_KEY` never reaches the browser — AI calls go through `/api/ai` only; generated SQL is inserted for review, never auto-executed.
- App state (saved queries, audit log, history, connections) lives in `bun:sqlite`, never inside a user database. DB names validated, identifiers quoted everywhere they're interpolated.
