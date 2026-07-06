# EVE Confluence - One-Asset Trade Focus Engine

EVE Confluence is the brain that reads the four existing EVE scanners and chooses one live focus asset.

It reads:

- EVE Bias results
- EVE Zones results
- EVE Structure results
- EVE Liquidity results

It does not invent new zones. It does not call Twelve Data from Netlify.

## Locked rules

- Minimum R:R is 1:2.
- Focus lock is 15 minutes.
- Stop loss is calculated before any trade idea is allowed.
- No SL = no trade idea.
- Trade ideas are confirmation-based market ideas only.
- No buy limits, sell limits, buy stops or sell stops in this first build.
- Railway WebSocket follows only the selected focus asset.
- Idea Stats button shows win rate and trade idea history.

## Deploy shape

This repo contains two deployable parts:

```text
/               Netlify EVE Confluence dashboard and scheduled scan
/railway        Railway WebSocket hub for the selected asset only
/supabase       SQL schema
```

## Netlify variables

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
EVE_ADMIN_PASSWORD
RAILWAY_PUBLIC_URL
```

`RAILWAY_PUBLIC_URL` is optional for now. The dashboard reads live price from Supabase because Railway writes the WebSocket price into Supabase.

## Railway variables

```text
TWELVEDATA_API_KEY
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

## Supabase

Run this once in the same Supabase project as the other EVE scanners:

```text
supabase/eve-confluence-schema.sql
```

## How it decides a trade idea

EVE Confluence checks:

1. Bias agrees.
2. Structure agrees.
3. Price is near/inside the correct zone.
4. Stop loss is clean first.
5. Liquidity target is meaningful.
6. R:R is at least 1:2.
7. Railway live price confirms the zone reaction.

Only then does it become an active trade idea.

## Performance tracking

The dashboard has an `Idea Stats` button.

It shows:

- Active win rate
- Total ideas formed
- Triggered ideas
- Wins
- Losses
- No trigger / expired
- Trigger rate
- Average R
- Idea history

Forming ideas are not counted as active trades until live confirmation happens.


## v2 live price symbol guard

This patch prevents Railway or the dashboard from displaying a stale/cross-symbol live price. The dashboard only shows a live price when the live price row matches the current focus symbol and was received after the focus locked. Railway also ignores WebSocket price messages unless the message explicitly contains the same symbol as the current focus.


## v3 focus clear + active trade follow fix
- Railway now syncs directly from the current focus every 3 seconds.
- Railway disconnects when focus is no_trade/closed and only streams forming/active ideas.
- Active confirmed trade ideas stay locked until TP or SL.
- Stats table displays No entry instead of 0.00000 for untriggered ideas.

## v5 state-machine upgrade

v5 changes the trade management logic from a simple forming/active flow into a strict state machine:

```text
FORMING = EVE has found the best asset, SL/TP/R:R are mapped, waiting for price to touch the correct zone.
ARMED = price has touched the correct zone, waiting for live reclaim/rejection confirmation.
ACTIVE = confirmation happened, entry/SL/TP/R:R are locked, follow until TP or SL.
```

Timer rules:

```text
forming_touch_minutes = 15
armed_confirmation_minutes = 30
confirmation_hold_seconds = 30
same_symbol_direction_cooldown_minutes = 10
```

WebSocket rules:

```text
forming = Railway WebSocket ON
armed = Railway WebSocket ON
active = Railway WebSocket ON
closed/no_trade = Railway WebSocket OFF
```

Active trade ideas still cannot switch assets until TP or SL.


V6 9-ASSET PATCH
- Confluence now scores only: EUR/USD, GBP/USD, AUD/USD, USD/JPY, USD/CAD, EUR/JPY, GBP/JPY, XAU/USD, BTC/USD.
- XAG/USD, ETH/USD and SOL/USD removed from new Confluence selection.
- v5 forming/armed/active state-machine logic remains in place.
- Run supabase/v6-9assets-confluence-patch.sql once after deploy.


## v7 admin button update
- Main page admin controls are hidden behind a small fixed Admin button.
- Admin panel contains Idea Stats, Scan Now, Unlock Focus, Turn Confluence On/Off, and Set/Change Admin Password.
- Confluence asset list is hard-filtered to 9 assets: EUR/USD, GBP/USD, AUD/USD, USD/JPY, USD/CAD, EUR/JPY, GBP/JPY, XAU/USD, BTC/USD.
