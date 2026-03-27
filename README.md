# gws-security-wrapper

`gws-security-wrapper` is a Bun HTTP server that wraps [`gog`](https://github.com/steipete/gogcli) commands behind token-based auth.

## Features

- `POST /api` executes `gog <subcommand>` with safe argv parsing (`shell: false`)
- Hybrid auth on `POST /api`:
  - `gog auth*` subcommands require `X-Admin-Token`
  - all other subcommands require `Authorization: Bearer <access-token>`
- `POST /auth/rotate` rotates the API bearer token
- Plain-text output passthrough from `gog` (merged stdout/stderr)
- Strict subcommand denylist for shell metacharacters: `;`, `|`, `&`, `` ` ``, `$(`
- Unit tests for auth, rotation, parsing, command execution, and platform checks

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
- API bearer token is stored under account `api-token` (or `GWS_KEYCHAIN_ACCOUNT`).

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
- `/api` with `subcommand` starting by `auth`: requires `X-Admin-Token`
- `/api` for all other subcommands: requires `Authorization: Bearer <access-token>`

Rotate API token:

```bash
curl -sS -X POST http://localhost:3000/auth/rotate \
  -H 'X-Admin-Token: <admin-token>'
```

Example response:

```json
{"token":"<new-api-token>"}
```

Call `gog calendar calendars -a viteinfinite@gmail.com --plain`:

```bash
curl -sS -X POST http://localhost:3000/api \
  -H "Authorization: Bearer <access-token>" \
  -H 'Content-Type: application/json' \
  --data '{"subcommand":"calendar calendars -a viteinfinite@gmail.com --plain"}'
```

Call `gog auth status --plain`:

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

This repo includes a reusable Codex skill at:

- `.codex/skills/gog-wrapper-server`

To install for another user, copy that folder to:

- `${CODEX_HOME:-$HOME/.codex}/skills/gog-wrapper-server`

Then restart Codex so the skill is discovered.
