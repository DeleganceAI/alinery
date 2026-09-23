# Public Library API

Contract for the Alinery desktop. Host: `https://accounts.alinery.ai`. Local override: `ALINERY_ACCOUNTS_URL` (dev default `http://localhost:3000`).

This document matches the routes in this repo. If an older ticket disagrees, this file wins.

There is no feature flag. The routes are live. A 404 from these paths is `not_found`, not a hidden flag.

No cookies. No CORS. The caller is the native app. Do not put a login form in the desktop. Auth is the stored GoTrue access token from desktop pairing.

The package is the v2 `playbook.md` text. No zip, no sidecar. One mutable row per publication. The previous body is not kept.

The document's `version = 2` is the format version inside `body`. The JSON field `version` is the catalog counter. Responses do not add a second field for the format version.

Catalog name is `label/playbook_key`. Two users may both publish `review`. Distinguish those rows by `label`. Do not hide one of them.

## Envelope

Success: `{ "ok": true, ... }`. `status` is not in the JSON. Create is HTTP 201. Other successes are HTTP 200.

Error: `{ "ok": false, "error": string, "code"?: string, "diagnostics"?: array }`. `diagnostics` is present only when the server set it, including an empty array. It is omitted otherwise.

Requests with a body must send `Content-Type: application/json`. A charset parameter is allowed. Anything else is HTTP 415:

```json
{ "ok": false, "error": "Expected application/json.", "code": "unsupported_media_type" }
```

Invalid JSON is not a 500. It is treated as `{}` and then fails the field checks below. `GET` and `DELETE` do not require `Content-Type`.

## Auth

When a route requires auth, send `Authorization: Bearer <GoTrue access token>`.

Missing header, wrong scheme, non-JWT, `alc_*`, `inf_*`, bad token, and expired token are the same response. Do not branch on which one it was.

```json
{ "ok": false, "error": "Sign in to continue.", "code": "unauthenticated" }
```

HTTP 401.

Browse routes ignore `Authorization`. A bad bearer on browse does not 401.

Service unavailable, including a store failure the server will not describe:

```json
{ "ok": false, "error": "Playbook library is unavailable. SUPABASE_SERVICE_ROLE_KEY is not configured on the server.", "code": "unavailable" }
```

HTTP 503. Do not show the raw server error. The body never includes `owner_id`, email, or a token.

## Ids and time

Path ids are lowercase UUID strings: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`. Anything else, including uppercase hex, is the same 404 as an unknown id. Do not expect 400.

```json
{ "ok": false, "error": "Playbook not found.", "code": "not_found" }
```

Timestamps are UTC ISO-8601, `Z` suffix, second precision: `2026-09-22T18:04:11Z`.

`body_sha256` is lowercase hex SHA-256 of the exact stored `body` bytes (UTF-8). The server does not add a BOM. A BOM the client sent stays in `body` and in the hash.

## Objects

### Summary

List, `GET :id`, and mine. No `body`. No `owner_id`. No email.

```json
{
  "id": "8c19b367-d20b-4e60-b2ec-df73d8123aa1",
  "label": "nyx",
  "playbook_key": "review",
  "title": "Review",
  "description": "Review a change.",
  "default_harness": "omp",
  "has_coding_step": false,
  "step_count": 4,
  "version": 3,
  "body_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "published_at": "2026-09-22T18:04:11Z",
  "updated_at": "2026-09-22T19:10:00Z"
}
```

All fields are required. `description`, `default_harness`, and `label` may be `""`. `version` is an integer `>= 1`. `has_coding_step` is true when any step has `is_coding_step = true`. `step_count` is the number of `[[step]]` records.

### Detail

Summary plus `body` and `attested_at`. Returned by create, update, and `GET :id/source`.

```json
{
  "body": "+++\nversion = 2\n...",
  "attested_at": "2026-09-22T19:10:00Z"
}
```

`body` is the stored document. Newlines are JSON escapes, not a second encoding. The server does not re-render the document.

Mine rows are summaries. They do not add `yanked` or `owner_id`.

## Cursor

Opaque. Pass it back as `cursor`. Do not parse it. Do not mint one.

Encoding is base64url, no `=` padding.

`sort=updated` (the default): payload is `updated_at`, then `,`, then `id`. Example payload `2026-09-22T19:10:00Z,8c19b367-d20b-4e60-b2ec-df73d8123aa1`. Order is `updated_at` descending, then `id` descending. The next page is rows strictly after that pair.

`sort=title`: payload is the stored title, then `,`, then `id`. Titles may contain commas; the id is after the last comma. Order is Unicode simple lowercase of the stored title, ascending, then `id` ascending. Not locale-aware.

A cursor from one sort used with the other is HTTP 400 `invalid_cursor`, not an empty page. So is a missing, padded, or undecodable cursor.

A stored title that is exactly `YYYY-MM-DDTHH:MM:SSZ` cannot be a title-sort page boundary. Do not rely on paging a catalog whose titles are timestamps.

## List query

`GET /api/desktop/playbooks` only. Unknown params are ignored. Duplicate params use the first value.

| Param | Rule |
|---|---|
| `q` | Optional. Trimmed. Length 1–80 after trim. Empty, whitespace, or absent: no text filter. Longer than 80: 400 `invalid_query` |
| `harness` | Optional. Exact match on `default_harness`. Max 64 UTF-8 bytes. Absent: no filter. Present and empty matches only `default_harness = ""` |
| `coding` | Optional. `1` or `0` only. Anything else, including empty: 400 `invalid_query`. Absent: no filter |
| `sort` | Optional. `updated` (default) or `title`. Anything else: 400 `invalid_query` |
| `cursor` | Optional. See above. Empty: 400 `invalid_cursor` |
| `limit` | Optional. Integer 1–50, canonical decimal (`1`, `24`, `50`). Default 24. `0`, `00`, `024`, `1.5`, `+24`, `51`: 400 `invalid_query` |

```json
{ "ok": false, "error": "Invalid query.", "code": "invalid_query" }
```

```json
{ "ok": false, "error": "Invalid cursor.", "code": "invalid_cursor" }
```

`q` is a case-insensitive substring over `title`, `description`, `playbook_key`, and `label`. `%`, `_`, and `\` in `q` are literal, not wildcards. A comma or parenthesis in `q` is not a 400.

`sort=updated` with no `q` pages the full catalog. `sort=title`, and any request with `q`, may omit matches once the catalog is large. There is no `truncated` field on the list response. Do not treat a short page as proof the catalog ended unless `next_cursor` is `null`.

## Routes

Base path: `/api/desktop/playbooks`.

### `GET /api/desktop/playbooks`

Browse. No auth. Summaries only. Never `body`, `owner_id`, or email.

```json
{ "ok": true, "playbooks": [], "next_cursor": null }
```

`next_cursor` is a string when another page exists, otherwise `null`. An empty filter match is 200 with `playbooks: []`, not 404.

### `GET /api/desktop/playbooks/:id`

Browse. No auth. One summary. The only excluded field is `body`. Unknown or malformed id is 404 `not_found`.

This is how a signed-out client shows title, description, version, and step count. It is not an import.

### `GET /api/desktop/playbooks/:id/source`

Import download. Bearer required. Returns the detail object, including `body`.

This is the only read of the document that requires auth. Browse routes cannot complete an import.

Auth is checked before the id is looked up. With no valid bearer, an unknown id and a malformed id are both 401. A valid bearer and a missing or malformed id are 404. Any signed-in user may download the body. Ownership is not required.

### `GET /api/desktop/playbooks/mine`

Bearer required. The caller's summaries, newest `updated_at` first, then `id` descending. No cursor.

Cap 1000. At 1000 or fewer, `"truncated": false` and every row is returned. Above 1000, the newest 1000 are returned and `"truncated": true`. The oldest rows are omitted.

```json
{ "ok": true, "playbooks": [], "truncated": false }
```

### `POST /api/desktop/playbooks/validate`

Bearer required. Writes nothing. Does not require `attest` or `label`.

```json
{ "source": "+++\nversion = 2\n..." }
```

`source` must be a string. Missing or non-string:

```json
{ "ok": false, "error": "Expected source text.", "code": "invalid_body" }
```

HTTP 400.

UTF-8 byte length greater than 262144:

```json
{ "ok": false, "error": "Playbook is larger than 256 KiB.", "code": "too_large" }
```

HTTP 413. A string that is also over the cap and contains NUL is 413, not the NUL error.

A source that passed the size check and contains U+0000:

```json
{ "ok": false, "error": "Playbook source must not contain a NUL byte.", "code": "invalid_body" }
```

HTTP 400.

Valid document, HTTP 200. `key_taken` is true only when this caller already has that `playbook_key`. Another user's identical key leaves `key_taken` false. `existing_id` is that row's id, or `null`. A document that fails only the per-user key check is still `valid: true`. Create then returns 409. Update of `existing_id` is the allowed write.

```json
{
  "ok": true,
  "valid": true,
  "key_taken": false,
  "existing_id": null,
  "summary": {
    "key": "review",
    "title": "Review",
    "description": "Review a change.",
    "default_harness": "omp",
    "step_count": 4,
    "has_coding_step": false
  }
}
```

If the document parses far enough to yield a string `key`, `key_taken` and `existing_id` are included even when other checks fail. If `key` did not parse, both are omitted. `summary` is included only when `valid` is true.

Invalid document, still HTTP 200. A validator refusal is not a failed HTTP request.

```json
{
  "ok": true,
  "valid": false,
  "diagnostics": [
    { "code": "empty_title", "message": "playbook title must not be empty", "line": null, "field": "title" }
  ]
}
```

### `POST /api/desktop/playbooks`

Publish. Bearer required. Creates catalog `version` 1.

```json
{
  "source": "+++\nversion = 2\n...",
  "label": "nyx",
  "attest": true
}
```

| Field | Rule |
|---|---|
| `source` | Required string. Same size, NUL, and parse rules as validate |
| `attest` | Required boolean `true`. Missing, `false`, or non-boolean is 400 `attest_required` |
| `label` | Required string if the caller has no label row. Omit it if they do. A different valid label when one is stored is 409 `label_set`. The same label is ignored. There is no rename route |

JSON `title`, `key`, `version`, and `step_count` are ignored. The server reads those from `source`.

Check order after the bearer: content-type, `source` string, size, NUL, `attest`, label, parse, then the per-user key. A failure does not insert a publication.

`attest` is not `true`:

```json
{ "ok": false, "error": "Confirm you can share this playbook.", "code": "attest_required" }
```

HTTP 400.

First publish, `label` key absent:

```json
{ "ok": false, "error": "Choose a public label.", "code": "label_required" }
```

HTTP 400. No row written.

`label` present and not a string, or not `^[a-z0-9][a-z0-9-]{1,31}$` (length 2–32). This beats `label_set`.

```json
{ "ok": false, "error": "Label must be a lowercase slug, 2 to 32 characters.", "code": "invalid_label" }
```

HTTP 400.

Label owned by another user:

```json
{ "ok": false, "error": "That label is taken.", "code": "label_taken" }
```

HTTP 409. No publication row written.

This caller already has this `playbook_key`:

```json
{ "ok": false, "error": "You already published this playbook. Update it.", "code": "conflict" }
```

HTTP 409. No `existing_id`. Call `GET /mine` to find the id. `version` is unchanged.

Parse failure after the checks above. The row is not inserted.

```json
{
  "ok": false,
  "error": "Playbook is not valid.",
  "code": "invalid_playbook",
  "diagnostics": []
}
```

HTTP 422.

Success HTTP 201. Body is the detail object at the top level, not wrapped in `playbook`. `version` is `1`. `published_at`, `updated_at`, and `attested_at` are the same second. The stored label is not changed by a later publish.

A label row can remain if publication insert fails after the label insert. That is not an error the client must undo. The next publish omits `label`.

### `PUT /api/desktop/playbooks/:id`

Update. Bearer required. Owner only.

```json
{ "source": "+++\nversion = 2\n...", "attest": true }
```

`label` is ignored. `attest` is required `true`, same 400 as create.

Order: 401, then malformed id 404, then load. Missing id is 404 `not_found`. Another owner's row is 403 and is not modified:

```json
{ "ok": false, "error": "You cannot update this playbook.", "code": "forbidden" }
```

Then size, NUL, attest, and parse. A failed parse does not bump `version` and does not change the row. Same 422 `invalid_playbook` as create.

If the parsed document `key` is not the row's `playbook_key`:

```json
{ "ok": false, "error": "The playbook key cannot change. Publish a new one.", "code": "key_changed" }
```

HTTP 422. No `diagnostics`. Row unchanged. `version` unchanged.

Success HTTP 200. Detail object. `version` is the previous value plus 1, even when `body_sha256` is unchanged. The counter means accepted publishes, not distinct bodies. Do not PUT on a timer. `published_at` is unchanged. `updated_at` and `attested_at` are the new second. `body` is replaced even when the hash matches.

If another update lands first, retry the same PUT. After repeated conflicts:

```json
{ "ok": false, "error": "Playbook was updated concurrently. Try again.", "code": "conflict" }
```

HTTP 409. This is not the create-conflict sentence. The row was not changed by this call.

### `DELETE /api/desktop/playbooks/:id`

Remove. Bearer required. Owner only. No body.

401, then malformed id 404, then load. Missing id is 404. Another owner:

```json
{ "ok": false, "error": "You cannot remove this playbook.", "code": "forbidden" }
```

Success HTTP 200:

```json
{ "ok": true, "deleted": true }
```

The publication row is gone. Local copies are not notified. The label row remains. A later create of the same `playbook_key` by the same owner is a new `id` and starts again at `version` 1.

## Server validation

The desktop must run its parser before publish and again before saving an import. The server copies the checks that are straightforward in JavaScript. A document the server accepts and the desktop parser rejects must not be published, and must not be saved on import.

The server checks:

- UTF-8, no NUL, at most 262144 bytes, before parse.
- Opening `+++` on its own line. Trailing `\r` is allowed. A trailing space is not. Code `missing_frontmatter`, message `expected v2 TOML +++ frontmatter at the beginning of the file`, `line` 1, `field` null.
- Closing `+++` on its own line. Code `missing_frontmatter_end`, message `missing closing +++ delimiter`, `line` 1, `field` null.
- TOML parses. Code `invalid_toml`. `line` and `field` are null.
- `version` is the integer 2. Code `unsupported_version`, message `only playbook version 2 is supported`, `field` `version`. `version = 1` is this code only. `version = 2.0` and `version = "2"` are also `invalid_field_type` (`version must be integer`).
- Required fields and types. Unknown fields fail. Messages: `required field {path} is missing`, `{path} must be {kind}`, `unknown field {path}`. `kind` is `integer`, `string`, `boolean`, or `array`.
- `key` and each step `key` match `^[a-z0-9][a-z0-9-]*$`. Messages: `playbook key must be a lowercase ASCII slug`, `step key must be a lowercase ASCII slug`.
- Title and each step title are non-empty after trim. The stored title is the parsed string, not the trimmed string. Messages: `playbook title must not be empty`, `step title must not be empty`.
- At least one step. Message `at least one step is required`, `field` `step`.
- Step keys are unique. Message `duplicate step {key}`.
- This caller's `key` is free, or is the publication being updated. Another user's row with the same key is not an error.

Required top-level fields: `version` integer, `key` string, `title` string, `description` string, `default_model` string, `default_harness` string, `step` array.

Each step: `key`, `title`, `short`, `model`, `harness` string; `is_coding_step`, `auto_advance_default` boolean; `inputs`, `outputs` array.

Each input: `path` string, `mode` string. Each output: `path` string. `mode` is not checked against a set. Unknown harness names are not rejected. Prompt text is not scanned for secrets.

If a structural code is present (`missing_field`, `invalid_field_type`, `unknown_field`, `invalid_toml`, `missing_frontmatter`, `missing_frontmatter_end`), slug, empty-title, and duplicate-step codes are not also returned. `unsupported_version` and `missing_steps` can appear beside structural codes.

Diagnostic object. `line` is a positive integer or `null`. `field` is a string or `null`. `severity` is not returned.

```json
{ "code": "missing_field", "message": "required field title is missing", "line": null, "field": "title" }
```

The server does not return `overlapping_outputs`, `invalid_selector`, `input_mode_path`, `coding_input`, `multiple_collections`, `reserved_output_namespace`, `unknown_prompt_token`, `invalid_input_mode`, or step-section pairing. Those stay in the desktop parser.

## Error catalog

| HTTP | code | error |
|---|---|---|
| 401 | `unauthenticated` | `Sign in to continue.` |
| 400 | `invalid_body` | `Expected source text.` |
| 400 | `invalid_body` | `Playbook source must not contain a NUL byte.` |
| 400 | `invalid_query` | `Invalid query.` |
| 400 | `invalid_cursor` | `Invalid cursor.` |
| 400 | `attest_required` | `Confirm you can share this playbook.` |
| 400 | `label_required` | `Choose a public label.` |
| 400 | `invalid_label` | `Label must be a lowercase slug, 2 to 32 characters.` |
| 403 | `forbidden` | `You cannot update this playbook.` |
| 403 | `forbidden` | `You cannot remove this playbook.` |
| 404 | `not_found` | `Playbook not found.` |
| 409 | `conflict` | `You already published this playbook. Update it.` |
| 409 | `conflict` | `Playbook was updated concurrently. Try again.` |
| 409 | `label_taken` | `That label is taken.` |
| 409 | `label_set` | `That label is already set.` |
| 413 | `too_large` | `Playbook is larger than 256 KiB.` |
| 415 | `unsupported_media_type` | `Expected application/json.` |
| 422 | `invalid_playbook` | `Playbook is not valid.` |
| 422 | `key_changed` | `The playbook key cannot change. Publish a new one.` |
| 503 | `unavailable` | `Playbook library is unavailable. SUPABASE_SERVICE_ROLE_KEY is not configured on the server.` |

## Minimal document the server accepts

```
+++
version = 2
key = "review"
title = "Review"
description = "Review a change."
default_model = ""
default_harness = "omp"
[[step]]
key = "read"
title = "Read"
short = "Read the diff"
is_coding_step = false
auto_advance_default = false
inputs = []
outputs = []
model = ""
harness = ""
+++
```
