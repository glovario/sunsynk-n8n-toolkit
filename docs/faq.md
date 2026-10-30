# FAQ

**Does it work without Intelligent Octopus?**
The guard needs Octopus `flexPlannedDispatches` for an EV or charger, so no. Evening Sell and Control don't use Octopus.

**Which cars and chargers?**
Any device Octopus lists as `ELECTRIC_VEHICLES` or `CHARGE_POINTS` on your account. `CHARGE_POINTS` hasn't been tested yet.

**Does it work with Deye or other Sunsynk-cloud inverters?**
Possibly, with `SUNSYNK_API_HOST=pv.inteless.com`. It's untested. Inverter models and firmware tested so far: **TBD**.

**Does it need a plant ID?**
No. Only the inverter serial (`SUNSYNK_INVERTER_SN`).

**Does it use Modbus or a local connection?**
No. Everything goes through the Sunsynk cloud API.

**Will it change my other timer slots?**
- The guard writes only `GUARD_SLOT`, never `GUARD_PROTECTED_SLOTS`, and never `sellTimeNEn`.
- Sell writes only `SELL_SLOT`.
- Control rejects anything that isn't a timer field.

**Why doesn't it arm hours in advance?**
Timer slots are daily times with no date. Arming early would also change today's slot at that time. So it arms at most `GUARD_LEAD_IN_MIN` (default 20) minutes ahead.

**What if Octopus is down?**
The run stops and nothing changes. It never treats a failed query as "no dispatches".

**What if Home Assistant is down?**
With the plug gate set, the guard restores the slot instead of arming, and reports `plug_error`. Without the plug gate, Home Assistant isn't used.

**How often does it call the APIs?**
- **Guard:** every 10 minutes. Octopus is called on every run. Sunsynk is called only when something changes.
- **Sell:** once a day.
- **Control:** reuses its login token until shortly before it expires.

Don't poll Sunsynk more often than every 5 minutes.

**How do I stop all writes quickly?**
Set `SUNSYNK_WRITES_ENABLED=false` and restart n8n, or deactivate Sunsynk Control.

This only **disables the automation**. It stops *future* writes; it does not undo anything already on the inverter. If the guard has armed its slot (`timeNOn=1`, `capN=100` or your `GUARD_CAP_SOC`, and a moved `sellTimeN`), those settings stay, and the guard can't send its restore while writes are off. Stopping during an extra dispatch can leave grid charging on into peak-rate hours.

To **restore the inverter to a safe state**, follow the [manual recovery procedure](safety.md#emergency-manual-recovery) before or alongside disabling writes.

**Can I test it without an inverter?**
Yes: `node tests/run.js`. See [testing.md](testing.md).

**Which n8n version?**
**TBD.** It needs Code nodes with `$env` and `this.helpers.httpRequest`.
