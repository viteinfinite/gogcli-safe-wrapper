# gws-security-wrapper

`gws-security-wrapper` is a Bun HTTP server that wraps [`gog`](https://github.com/steipete/gogcli) commands behind token-based auth.

## Features

- `POST /api` executes `gog <subcommand>` with safe argv parsing (`shell: false`)
- Scoped bearer tokens with per-top-level command scopes:
  - `READ`
  - `SAFE_WRITE`
  - `FULL_WRITE`
- Hybrid auth on `POST /api`:
  - `gog auth*` subcommands require `X-Admin-Token` (admin-only)
  - all other subcommands require `Authorization: Bearer <access-token>` + scope check
- Token management APIs:
  - `POST /auth/rotate` (create or rotate scoped tokens)
  - `GET /auth/tokens` (list token metadata)
  - `POST /auth/tokens/revoke` (revoke token by id)
- Plain-text output passthrough from `gog` (merged stdout/stderr)
- Strict subcommand denylist for shell metacharacters: `;`, `|`, `&`, `` ` ``, `$(`
- Command scope policy built from `gog schema --json` with conservative overrides

## Scope Model

Token scopes are assigned per top-level command key (format: `subcommand:SCOPE`).

Available levels:

- `READ`: read-only operations
- `SAFE_WRITE`: non-destructive writes (for example create draft, modify metadata)
- `FULL_WRITE`: sensitive/destructive writes (for example send/delete/share/revoke)

Rules:

- `/api` `auth*` commands are always admin-only (not bearer-scope controlled).
- For non-`auth*`, missing scope entry is deny-by-default.
- Scope check is hierarchical: `FULL_WRITE` >= `SAFE_WRITE` >= `READ`.
- Aliases are normalized to canonical top-level command keys before evaluation.

Action classification:

- Policy is generated from `gog schema --json`.
- Command leaves are classified with keyword rules + explicit overrides in code for ambiguous commands.
- Unknown commands are denied with `403`.

## Prerequisites

- macOS or Linux
- [Bun](https://bun.sh) 1.3+
- `gog` installed and authenticated

## Configuration

Required:

- Admin secret in keychain/secret-store:
  - service: `gws-security-wrapper` (or `GWS_SECRET_SERVICE`)
  - account: `admin-token` (or `GWS_ADMIN_ACCOUNT`)

Optional:

- `PORT` (default: `3000`)
- `GOG_BIN` (default: `gog`)
- `GWS_SECRET_SERVICE` (default: `gws-security-wrapper`)
- `GWS_KEYCHAIN_ACCOUNT` (default: `api-token`)
- `GWS_ADMIN_ACCOUNT` (default: `admin-token`)
- `GWS_SECRET_FILE` (Linux fallback file, default: `~/.config/gws-security-wrapper/secrets.json`)

Notes:

- Secret backend uses native keyring access (`@napi-rs/keyring`).
- Scoped token registry is stored under account `api-token` (or `GWS_KEYCHAIN_ACCOUNT`).
- Legacy single-token storage auto-migrates to scoped token registry on startup.

## Run

```bash
bun run src/server.ts
```

## Test

```bash
bun test
```

## API Examples

Auth matrix:

- `/auth/rotate`: requires `X-Admin-Token`
- `/auth/tokens`: requires `X-Admin-Token`
- `/auth/tokens/revoke`: requires `X-Admin-Token`
- `/api` with `subcommand` starting by `auth`: requires `X-Admin-Token`
- `/api` for all other subcommands: requires `Authorization: Bearer <access-token>`

`scopeSpec` format:

- comma-separated `subcommand:SCOPE`
- example: `gmail:SAFE_WRITE,calendar:FULL_WRITE,drive:READ`
- `subcommand` is top-level command key (aliases normalized)
- missing scope entry for a command => denied (`403`)

Generate SAFE_WRITE token for Gmail + Calendar:

```bash
curl -sS -X POST http://localhost:3000/auth/rotate \
  -H 'X-Admin-Token: <admin-token>' \
  -H 'Content-Type: application/json' \
  --data '{"scopeSpec":"gmail:SAFE_WRITE,calendar:SAFE_WRITE"}'
```

Create scoped token (`tokenId` omitted, `scopeSpec` required):

```bash
curl -sS -X POST http://localhost:3000/auth/rotate \
  -H 'X-Admin-Token: <admin-token>' \
  -H 'Content-Type: application/json' \
  --data '{"scopeSpec":"gmail:SAFE_WRITE,calendar:READ"}'
```

Example response:

```json
{
  "mode":"created",
  "tokenId":"tok_abc123",
  "token":"<new-access-token>",
  "scopeSpec":"calendar:READ,gmail:SAFE_WRITE"
}
```

Rotate existing token by id:

```bash
curl -sS -X POST http://localhost:3000/auth/rotate \
  -H 'X-Admin-Token: <admin-token>' \
  -H 'Content-Type: application/json' \
  --data '{"tokenId":"tok_abc123"}'
```

List tokens (metadata only):

```bash
curl -sS http://localhost:3000/auth/tokens \
  -H 'X-Admin-Token: <admin-token>'
```

Revoke token:

```bash
curl -sS -X POST http://localhost:3000/auth/tokens/revoke \
  -H 'X-Admin-Token: <admin-token>' \
  -H 'Content-Type: application/json' \
  --data '{"tokenId":"tok_abc123"}'
```

Call `gog calendar calendars -a viteinfinite@gmail.com --plain`:

```bash
curl -sS -X POST http://localhost:3000/api \
  -H "Authorization: Bearer <access-token>" \
  -H 'Content-Type: application/json' \
  --data '{"subcommand":"calendar calendars -a viteinfinite@gmail.com --plain"}'
```

Call admin-only `gog auth status --plain`:

```bash
curl -sS -X POST http://localhost:3000/api \
  -H "X-Admin-Token: <admin-token>" \
  -H 'Content-Type: application/json' \
  --data '{"subcommand":"auth status --plain"}'
```

Injection attempt is rejected:

```bash
curl -i -sS -X POST http://localhost:3000/api \
  -H "Authorization: Bearer <access-token>" \
  -H 'Content-Type: application/json' \
  --data '{"subcommand":"calendar calendars; whoami"}'
```

## Live Parity Validation

Compare direct `gog` output to wrapper output for the same command:

```bash
gog calendar calendars -a viteinfinite@gmail.com --plain
```

```bash
curl -sS -X POST http://localhost:3000/api \
  -H "Authorization: Bearer <access-token>" \
  -H 'Content-Type: application/json' \
  --data '{"subcommand":"calendar calendars -a viteinfinite@gmail.com --plain"}'
```

The response body from `/api` should match the CLI text output.

## Deployable Skill

This repo includes a reusable user-facing Codex skill at:

- `.codex/skills/gog-wrapper-server`

Skill purpose:

- Focus on how to call `/api` safely with bearer tokens.
- Explain command formatting and output interpretation.
- Intentionally excludes admin/token-management workflows.

To install for another user, copy that folder to:

- `${CODEX_HOME:-$HOME/.codex}/skills/gog-wrapper-server`

Then restart Codex so the skill is discovered.
