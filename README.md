# mysql-fast-ui

A fast, single-binary-feel web console for **MySQL** — query, browse, build, and administer your databases from the browser. Bun-powered, zero npm runtime dependencies, AES-256-GCM-encrypted multi-server connections.

> Ported from [`pg-admin-lite`](https://github.com/) (the PostgreSQL edition). Same UX, retargeted at MySQL 8.

## Features

- **SQL console** — CodeMirror 6 editor with MySQL syntax highlighting, inline error markers, ⌃↵ run-statement/selection, ⌃⇧↵ run-all. Friendly errors (MySQL errno → plain language + "did you mean").
- **Browse** — schema tree, keyset-paginated grids, in-cell edit, CSV export, sort/resize/freeze columns.
- **Builder** — visual `CREATE TABLE` / `ALTER TABLE` with a MySQL type guide (`BIGINT AUTO_INCREMENT`, `JSON`, `DATETIME`, `ENUM`…), constraints, FKs, indexes → reviewable DDL.
- **EXPLAIN** — `EXPLAIN FORMAT=JSON` with heuristic hints.
- **Multi-server** — save direct or SSH-tunnelled (PEM key) connections; passwords and keys encrypted at rest.
- **Transfer** — `mysqldump` export / `mysql` import.
- **AI (optional)** — natural-language → SQL and fix-my-query via Claude, when `ANTHROPIC_API_KEY` is set. Generated SQL is inserted for review, never auto-run.
- **Dark mode**, query history, saved queries, audit log — all in a local `bun:sqlite` store, never inside your databases.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- MySQL 8.0 reachable (the `mysqldump`/`mysql` clients on `PATH` for Transfer)

## Quick start

```bash
git clone git@github.com:birendrasmartxalgo-wq/my-sql-fast-ui.git
cd my-sql-fast-ui
cp .env.example .env        # then edit credentials (see below)
bun start                   # http://localhost:4602
```

### `.env`

```
MYSQL_HOST=127.0.0.1        # use 127.0.0.1, not "localhost"
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=
MYSQL_MAINT_DB=mysql
ADMIN_PASSWORD=change-me     # gates the web UI (and every saved server)
PORT=4602
# ANTHROPIC_API_KEY=sk-...   # optional, enables the AI features
# AI_MODEL=claude-opus-4-8
```

Open the app, log in with `ADMIN_PASSWORD`, and you're on the local MySQL. Add more servers from the switcher.

## Development

```bash
bun run dev      # watch-reload server
bun run css      # rebuild Tailwind CSS after changing markup/JS classes
bun run cm       # rebuild the vendored CodeMirror bundle after editing vendor/cm/entry.js
```

## Security notes

Runs with whatever MySQL account you configure and is gated only by `ADMIN_PASSWORD` — put it behind a trusted network or reverse proxy if exposed. Saved credentials and PEM keys are AES-256-GCM encrypted in `data/mysql-fast.sqlite` using `data/secret.key`; keep both out of any backup that leaves the machine. The Anthropic API key stays server-side and is never sent to the browser.

## License

See [LICENSE](LICENSE).
