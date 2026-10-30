# Sunsynk Control (`workflows/sunsynk-control.json`)

The only workflow that talks to the Sunsynk cloud. Everything else calls it.

## Nodes

```
Webhook → Validate Request → Sunsynk Login → Write And Verify
```

### 1. Webhook
- `POST /webhook/sunsynk-control`, with Header Auth.
- The response mode is "last node", so the caller gets Write And Verify's output.

### 2. Validate Request (Code)
- **Serial:** `sn` comes from the body, falling back to `SUNSYNK_INVERTER_SN`, and must be 6–12 digits.
- **Command:** must be one of these, and each `params` key must match its pattern:

  | command | allowed fields |
  |---|---|
  | `set_sell_time` | `sellTime1`–`6` (`HH:MM`) |
  | `set_grid_charge` | `time1On`–`6On`, `time1on`–`6on` |
  | `set_charge_cap` | `cap1`–`6` (10–100) |
  | `set_sell_enable` | `sellTime1En`–`6En` |

- **Dry run:** `dry_run` is true unless the body has `"dry_run": false` **and** `SUNSYNK_WRITES_ENABLED` is `true`.
- **Output:** `{ sn, command, params, dry_run, writes_enabled }`.

### 3. Sunsynk Login (Code)
- **Runs even in dry run.** It needs `crypto` (`NODE_FUNCTION_ALLOW_BUILTIN=crypto`) and `SUNSYNK_USERNAME` / `SUNSYNK_PASSWORD`.
- **Cached token:** reuses the bearer token from workflow static data until 60 seconds before it expires.
- **Otherwise it logs in:**
  1. Fetches the public key from `/anonymous/publicKey`.
  2. RSA-encrypts the password.
  3. POSTs to `/oauth/token/new` on `SUNSYNK_API_HOST`.
- **Failure:** stops with "Sunsynk login failed (MFA accounts are not supported)".

### 4. Write And Verify (Code)
- **Dry run:** returns `{ ok: true, dry_run: true, would_write, command }` without calling Sunsynk.
- **Otherwise:**
  1. POSTs the params to `/api/v1/common/setting/<sn>/set`.
  2. GETs `/api/v1/common/setting/<sn>/read`.
  3. Compares each field.
- **Comparison rules:**
  - The `timeNOn` and `timeNon` spellings are treated as the same field.
  - `1` / `true` and `0` / `false` count as equal.
- **Output:** `{ ok, dry_run: false, command, set_reply_success, mismatches }`.
  - `ok` is true only when `mismatches` is empty.
  - `set_reply_success` is shown for information only, because a "success" reply can be wrong (see [../timer-quirks.md](../timer-quirks.md)).

## Diagnostics
When a check fails, the node throws, so the webhook call fails and the caller's run stops. Exactly what the caller sees, the HTTP status and body, is **TBD** and depends on n8n.

The messages:
- `Missing or invalid inverter serial (sn)`
- `Unknown command: …`
- `Field … not allowed for …`
- `… must be HH:MM`
- `… must be 10-100`
- the `crypto` message
- `Set SUNSYNK_USERNAME and SUNSYNK_PASSWORD…`
- `Sunsynk public key request failed`
- `Sunsynk login failed…`
