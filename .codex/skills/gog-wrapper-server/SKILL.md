---
name: gog-wrapper-server
description: Use the gws-safe wrapper as an API client for running gog subcommands with a bearer token. Focus only on forming safe /api calls, choosing correct subcommands, and interpreting plain-text gog output.
---

# Gog Wrapper Client

Use `POST /api` to execute `gog` subcommands through the wrapper.

## Scope

- This skill is user-facing and intentionally excludes admin operations.
- Assume the caller already has a valid bearer token.
- Use this skill to:
  - Build valid `/api` requests.
  - Pick the correct `gog` subcommand syntax (after root `gog`).
  - Validate whether output indicates success, auth issues, or scope denial.

## Request Pattern

```bash
curl -sS -X POST http://localhost:3000/api \
  -H "Authorization: Bearer <access-token>" \
  -H "Content-Type: application/json" \
  --data '{"subcommand":"<gog args after root>"}'
```

## Examples

Read Gmail:

```bash
curl -sS -X POST http://localhost:3000/api \
  -H "Authorization: Bearer <access-token>" \
  -H "Content-Type: application/json" \
  --data '{"subcommand":"gmail messages search \"in:inbox\" -a viteinfinite@gmail.com --plain"}'
```

Create a Gmail draft (SAFE_WRITE):

```bash
curl -sS -X POST http://localhost:3000/api \
  -H "Authorization: Bearer <access-token>" \
  -H "Content-Type: application/json" \
  --data '{"subcommand":"gmail drafts create -a viteinfinite@gmail.com --to viteinfinite@gmail.com --subject \"Draft from wrapper\" --body \"Hello\" --plain"}'
```

## Response Interpretation

- `200 text/plain` with rows/text: command executed (even if gog reports an API error in text).
- `401 {"error":"unauthorized"}`: missing/invalid bearer token.
- `403 {"error":"forbidden_by_scope_policy",...}`: token scope does not allow that command.
- `400 {"error":"subcommand contains disallowed metacharacters"}`: blocked injection pattern.

## Guardrails

- Always send only the portion after `gog` in `subcommand`.
- Do not include shell metacharacters: `;`, `|`, `&`, backticks, `$(`.
- Prefer `--plain` for stable text output.
