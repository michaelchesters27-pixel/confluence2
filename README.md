# EVE Trade Idea Engine v13

This is the **complete GitHub-ready project** built from the existing EVE Confluence repository structure. Replace the contents of the existing `confluence2` repository with this project.

There are **no patch files** and no separate partial code deliveries.

## Strategy

EVE checks two trade setups across all 12 markets:

1. **Pullback** into demand or supply in the Bias direction.
2. **Breakout and retest** after a Bias-aligned BOS.

The four existing scanners have clear jobs:

- Bias chooses BUY or SELL direction.
- Zones provide pullback entry areas.
- Structure provides breakout/retest setups and supports confirmation.
- Liquidity provides the take-profit target.

No single optional scanner is allowed to silently veto every setup.

## Idea windows

### London

- 08:15 to 11:00
- `Europe/London`
- Automatically handles GMT and BST.

### New York

- 08:30 to 11:00 New York local time
- `America/New_York`
- Automatically handles US and UK clock changes.

No new ideas are created outside these windows. Existing forming, armed or active ideas continue being followed every five minutes until finished.

## Risk rules

- Planned idea: minimum 1:2 R:R.
- Confirmed M5 market entry: minimum 1:1.5 R:R.
- Below 1:1.5 after confirmation: **DO NOT CHASE**.
- Only one strongest idea is followed at a time.

## Railway

Railway and WebSockets are removed completely. EVE uses completed five-minute scanner data stored in Supabase.

## Complete Supabase setup

Run the one complete file included in this project:

`supabase/EVE_FULL_SUPABASE_SETUP.sql`

It handles both:

- upgrading the existing EVE Confluence tables; and
- creating the tables for a fresh installation.

It does not modify the Bias, Zones, Structure or Liquidity scanner tables.

## Netlify variables

Keep:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `EVE_ADMIN_PASSWORD`

Delete:

- `RAILWAY_PUBLIC_URL`

## GitHub deployment

1. Open the existing `confluence2` repository.
2. Delete the old files.
3. Upload every file and folder from this complete project.
4. Commit the changes.
5. Let Netlify deploy automatically.
6. Run `supabase/EVE_FULL_SUPABASE_SETUP.sql` in Supabase SQL Editor.
7. Disable or delete the old Railway service.
