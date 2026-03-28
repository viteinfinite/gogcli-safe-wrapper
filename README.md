# gogcli-security-wrapper

`gogcli-security-wrapper` is a Bun HTTP server that wraps [`gog`](https://github.com/steipete/gogcli) commands behind token-based auth.

## Features

- `POST /api` executes `gog <subcommand>` with safe argv parsing (`shell: false`)
- Scoped bearer tokens with explicit command allowlists.
- Hybrid auth on `POST /api`:
  - `gog auth*` subcommands require `X-Admin-Token` (admin-only)
  - all other subcommands require `Authorization: Bearer <access-token>` + allowlist check
- Token management APIs:
  - `POST /auth/rotate` (create or rotate scoped tokens)
  - `GET /auth/tokens` (list token metadata)
  - `POST /auth/tokens/revoke` (revoke token by id)
  - `POST /auth/tokens/revoke-all` (revoke all active tokens)
- Plain-text output passthrough from `gog` (merged stdout/stderr)
- Strict subcommand denylist for shell metacharacters: `;`, `|`, `&`, `` ` ``, `$(`
- Command allowlist policy built from canonical command groups

## Allowlist Model

Token permissions are assigned as explicit allowlist entries:

- `<top-level>` (for example `gmail`) allows all discovered groups under that top-level command.
- `<top-level>:<group>` (for example `gmail:search`) allows only one discovered group.

Rules:

- `/api` `auth*` commands are always admin-only (not bearer-scope controlled).
- For non-`auth*`, missing allowlist entry is deny-by-default.
- Aliases are normalized to canonical command keys before evaluation.

Command catalog:

- Policy is generated from canonical command-group discovery (`gog schema --json` at runtime).
- Unknown commands are denied with `403`.

## Prerequisites

- macOS or Linux
- [Bun](https://bun.sh) 1.3+
- `gog` installed and authenticated

## Configuration

Required:

- Admin secret in keychain/secret-store:
  - service: `gogcli-security-wrapper` (or `GWS_SECRET_SERVICE`)
  - account: `admin-token` (or `GWS_ADMIN_ACCOUNT`)

Optional:

- `PORT` (default: `3000`)
- `GOG_BIN` (default: `gog`)
- `GWS_SECRET_SERVICE` (default: `gogcli-security-wrapper`)
- `GWS_KEYCHAIN_ACCOUNT` (default: `api-token`)
- `GWS_ADMIN_ACCOUNT` (default: `admin-token`)
- `GWS_SECRET_FILE` (Linux fallback file, default: `~/.config/gogcli-security-wrapper/secrets.json`)

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

Discover canonical third-level allowlist keys from latest public `gog`:

```bash
bun run discover:gog-third-level
```

## API Examples

Auth matrix:

- `/auth/rotate`: requires `X-Admin-Token`
- `/auth/tokens`: requires `X-Admin-Token`
- `/auth/tokens/revoke`: requires `X-Admin-Token`
- `/auth/tokens/revoke-all`: requires `X-Admin-Token`
- `/api` with `subcommand` starting by `auth`: requires `X-Admin-Token`
- `/api` for all other subcommands: requires `Authorization: Bearer <access-token>`

`scopeSpec` format:

- comma-separated allowlist entries
- example: `gmail,calendar:search,drive`
- each entry is either a top-level command key or `top-level:group` (aliases normalized)
- missing allowlist entry for a command => denied (`403`)

Generate token for all Gmail commands and only Calendar search:

```bash
curl -sS -X POST http://localhost:3000/auth/rotate \
  -H 'X-Admin-Token: <admin-token>' \
  -H 'Content-Type: application/json' \
  --data '{"scopeSpec":"gmail,calendar:search"}'
```

Create scoped token (`tokenId` omitted, `scopeSpec` required):

```bash
curl -sS -X POST http://localhost:3000/auth/rotate \
  -H 'X-Admin-Token: <admin-token>' \
  -H 'Content-Type: application/json' \
  --data '{"scopeSpec":"gmail:drafts,calendar"}'
```

Example response:

```json
{
  "mode":"created",
  "tokenId":"tok_abc123",
  "token":"<new-access-token>",
  "scopeSpec":"calendar,gmail:drafts"
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

Revoke all tokens:

```bash
curl -sS -X POST http://localhost:3000/auth/tokens/revoke-all \
  -H 'X-Admin-Token: <admin-token>'
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
