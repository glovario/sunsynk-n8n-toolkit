# Evening Sell (`workflows/evening-sell.json`)

This optional workflow sets one timer slot for an evening export. It's **off by default**.

## Nodes

```
Daily 17:55 → Set Sell Window
```

### 1. Daily 17:55 (schedule trigger)
Cron `55 17 * * *`. It uses n8n's own timezone setting, which is **TBD** for your instance. Check `GENERIC_TIMEZONE` / the workflow settings.

### 2. Set Sell Window (Code)
1. **Reads its settings:** `SELL_SLOT` (6), `SELL_START` (18:00), `SELL_FLOOR_SOC` (50), `SELL_ENABLED` (false), `SELL_DRY_RUN` (true) and `SELL_WRITE_ENABLE_FLAG` (false).
2. **Checks them, stopping at the first problem:**
   - slot 1–6
   - slot ≠ `GUARD_SLOT` (default 5)
   - start `HH:MM`
   - floor 20–100
3. **Builds the commands for slot N:**
   - `set_sell_time` → `sellTimeN = SELL_START`
   - `set_charge_cap` → `capN = SELL_FLOOR_SOC`
   - `set_grid_charge` → `timeNOn = '0'`, `timeNon = 'false'`
   - only if `SELL_WRITE_ENABLE_FLAG=true`: `set_sell_enable` → `sellTimeNEn = '1'` when `SELL_ENABLED`, otherwise `'0'`
4. **Sends each command** to Sunsynk Control with the webhook header. `dry_run` is true unless `SELL_DRY_RUN=false` **and** `SELL_ENABLED=true`.

## Decision logic

There's no state and no stop marker. The same commands are sent every day, and Control's read-back reports whether each one took effect.

Sell doesn't check slot order or `GUARD_PROTECTED_SLOTS`. If Sell's slot is the guard's next slot, keep `GUARD_SLOT_NEXT_START` equal to `SELL_START` (see [../configuration.md](../configuration.md#evening-sell)).

## Output
`{ slot, start, floor, enabled, dry_run, results }`. `results` holds Control's reply for each command:
- `would_write` in dry run
- `ok` / `mismatches` when live

Sell doesn't fail the run when a reply has `ok: false`. Check `results` yourself.

Whether the inverter actually exports in this slot depends on its work mode and firmware: **TBD**. Check your DNO export limit and tariff before enabling.
