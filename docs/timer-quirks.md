# Sunsynk timer quirks (found the hard way)

Observed on one UK Sunsynk hybrid via the cloud API. Your firmware may differ. Please report what you see.

1. **Two spellings of grid charge.** The settings read returns `timeNon` ("true"/"false") while some writes only take effect as `timeNOn` ("1"/"0"). The workflows send both.
2. **"success" doesn't mean it worked.** A `set` call can return success and change nothing. Sunsynk Control always reads the settings back and reports mismatches.
3. **`sellTimeNEn` (per-slot Sell enable).** On some firmware the cloud write is ignored and the flag has to be set once on the inverter screen or in the app. It's off by default here (`SELL_WRITE_ENABLE_FLAG=false`).
4. **Slot times must stay in order.** Slot N's start is slot N-1's end. Writing a time out of sequence can be rejected or shift the next slot. Keep the guard and Sell on fixed slots and leave the others alone.
5. **Boolean mapping in reads.** Read values come back as strings ("true", "1", "false", "0"). Treat both forms as the same when comparing.
6. **Rate limits and MFA.** Don't poll more often than every 5 minutes. Accounts with MFA can't log in through this API.
