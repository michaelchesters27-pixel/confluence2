# EVE Confluence v14

This is the complete GitHub-ready replacement for the existing `confluence2` repository.

There are no patch files. Replace the repository contents with this project.

## What v14 does

EVE keeps the four existing scanners separate:

- **Bias** chooses BUY or SELL direction.
- **Zones** provide the reaction area.
- **Structure** adds context and broken-level retest opportunities.
- **Liquidity** provides sweep context and the target.

Netlify scans every five minutes, scores every market currently supplied by the four scanners and selects only the strongest qualifying focus.

Railway then connects Twelve Data WebSocket to that one selected symbol only.

Railway alone manages:

1. Entry-area touch.
2. Live reclaim or rejection.
3. Activation.
4. TP, SL and active-trade expiry.
5. MFE, MAE, best R and worst R.
6. Final outcome in Supabase.

Netlify no longer has a second activation engine. This removes the old conflict where a completed M5 scan and Railway could independently accept or reject the same idea.


## Critical bias fix

The old Confluence decision layer misunderstood the live Bias table in two ways:

- Bearish `bias_score` values are negative by design. The old code clamped them to zero, so strong bearish markets could never qualify.
- Bias statuses such as `Good watch` and `Watch only` were treated as a prohibition simply because they contained the word `watch`.

v14 uses the absolute directional strength, keeps the separate Bias quality score, and only excludes genuinely unusable states such as `Avoid`, `Closed`, `Stale` or `Error`.

## Entry model

### Zone reaction BUY

- Bias is bullish.
- Price approaches or enters demand.
- Railway arms the idea when demand is touched.
- A live reclaim crosses the pre-calculated trigger entry.
- Two live ticks over at least two seconds confirm activation.

### Zone reaction SELL

- Bias is bearish.
- Price approaches or enters supply.
- Railway arms the idea when supply is touched.
- A live rejection crosses the pre-calculated trigger entry.
- Two live ticks over at least two seconds confirm activation.

### Broken-level retest

A recent Bias-aligned BOS supplies the broken level. Railway waits for the retest and then the live reclaim/rejection.

## Risk rules

- Minimum planned R:R remains **1:2**.
- Entry, SL and TP are calculated before Railway takes control.
- The trigger entry is part of the plan, so EVE does not wait for a completed M5 candle and then reject the trade after the move has already happened.
- Railway rejects only an abnormal live jump beyond the trigger, controlled by `max_entry_slippage_risk_fraction`.
- One focus idea at a time.
- An active trade stays locked until TP, SL, manual close or active time-exit.

## Idea windows

### London

- 08:15 to 11:00
- `Europe/London`

### New York

- 08:30 to 11:00 New York local time
- `America/New_York`

No new focus is selected outside these windows. Any existing idea continues live until finished.

## Supabase

Run the one complete file:

`supabase/EVE_FULL_SUPABASE_SETUP.sql`

It preserves historical Confluence rows, adds the v14 live-management fields and resets unfinished old ideas as cancelled.

## Netlify variables

Keep:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `EVE_ADMIN_PASSWORD`
- `RAILWAY_PUBLIC_URL`

`RAILWAY_PUBLIC_URL` should be:

`https://confluence1-production.up.railway.app`

unless Railway gives you a different public URL.

## Railway variables

Keep:

- `TWELVEDATA_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Railway service settings:

- Root directory: `railway`
- Start command: `npm start`

## Deployment order

1. Run `supabase/EVE_FULL_SUPABASE_SETUP.sql`.
2. Replace the contents of the existing `confluence2` GitHub repository.
3. Let Netlify deploy.
4. Let Railway deploy from the same repository.
5. Open the Railway `/health` URL and confirm `ok: true`.
6. Open the Netlify dashboard and press **Scan Now**.
