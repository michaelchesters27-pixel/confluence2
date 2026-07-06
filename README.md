# EVE Confluence v9 - Fresh Source Gate + Candidate Logic

This version is built from the deployed v8 admin-password-gate file.

## Main changes

- Confluence scheduled scan runs every minute.
- The four backbone scanner freshness boxes are shown at the top:
  - Bias
  - Structure
  - Zones
  - Liquidity
- Confluence only makes a new trade decision when all four source scanners have a real completed scan for the current source cycle.
- Confluence ignores skipped/recent/starting/failed source scan runs.
- Candidate logic added:
  - Candidate = valid setup exists, but price is not close enough to the zone yet. No WebSocket focus.
  - Forming = price is near/inside the correct zone. Focus locks and Railway can watch live price.
  - Armed = zone touched, waiting live confirmation.
  - Active = confirmation happened; entry/SL/TP/R:R locked.
- Bias gatekeeper tightened:
  - Bias must be at least 70%.
  - Watch Only bias is rejected.
- R:R is projected from the correct zone/confirmation area instead of blindly from random current price.
- Small sound alerts added:
  - forming
  - armed
  - active
- Existing small Admin button/password gate preserved.
- Existing 9-asset list preserved.

## Deployment

Upload all files to the GitHub repo currently connected to Netlify/Railway: `confluence2`.

Railway settings remain:
- Root directory: `railway`
- Start command: `npm start`

No new Netlify variables are required.
No Supabase SQL patch is required for v9.
