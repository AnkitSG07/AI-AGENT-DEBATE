# FedEx sender/pickup address: code comparison and minimal correction

## Versions compared
- Earlier working FedEx project: `SmartHandicrafts_FedEx_Integration_Full.zip` (original)
- Last pre-invoice release: `SmartHandicrafts_FedEx_USD_Rate_Currency_Full_Project.zip`
- Latest invoice/preflight release: `SmartHandicrafts_FedEx_Prelabel_Commercial_Invoice_Full.zip`

## Verified differences
1. **Second street line intentionally stopped inheriting legacy settings:** the original `fedex-integration.js` used `FEDEX_ORIGIN_LINE2 || SHIP_FROM_LINE2`. Following the address correction, it uses `FEDEX_ORIGIN_LINE2` only. This avoids concatenating an Okhla street with the Mayapuri address text found in earlier screenshots, but also explains why line 2 is no longer automatically filled from legacy Render settings.
2. **State code was not being imported from legacy settings:** the original label maker's `server.js` uses `SHIP_FROM_STATE`; FedEx's `originAddress()` previously read only `FEDEX_ORIGIN_STATE_CODE`. This could leave `fxFromState` empty despite a configured Label Maker origin.
3. **Origin fetching happened only at page initialization:** in both the previous and newest `public/fedex.js`, `loadConfig()` filled the sender via `GET /api/fedex/config`, while `loadOrder()` filled only the destination. If the configuration request failed before login, opening an order later did not retry it. The new invoice code does not directly delete sender fields.
4. **Rate button recovery:** a failed initial configuration request disabled Get Rates. A later successful configuration refresh did not explicitly re-enable it.

## Minimal patch
- Retry `GET /api/fedex/config` when loading an Odoo sales order, after authentication may have completed.
- Fill only missing sender fields on the retry, preserving operator edits.
- Restore the legacy `SHIP_FROM_STATE` fallback and normalize `SHIP_FROM_COUNTRY=India` to `IN`.
- Keep the unsafe, conflicting old `SHIP_FROM_LINE2` excluded; `FEDEX_ORIGIN_LINE2` may be used for a verified second line.
- Clearly flag missing origin fields in the connection notice.
- Re-enable the rate button on a successful shipping configuration check.
- Update the FedEx script version to avoid a stale cached browser asset.

## Tests
- Existing backend and mocked FedEx workflow tests pass.
- New dynamic browser test simulates an initial configuration request failing before login followed by successfully loading a sales order after login. It checks that sender details are populated and that previously edited data is preserved.
- Total: 17 tests passing (including the new browser scenario).

## After deployment
1. Push the patch files with their original relative paths to GitHub.
2. Wait for Render to show the new live deployment; hard-refresh the application.
3. Sign in, open FedEx, load order `SO-26/27-00353`.
4. Check the sender contact, first street, city, state, postal and country. Verify the true pickup street and do not combine Okhla and Mayapuri.
5. If those fields still remain blank, inspect the `origin` object returned by the authenticated `GET /api/fedex/config`. That distinguishes missing Render environment settings from a browser issue; conceal all identifying details in screenshots.

Note: The deployed Render environment is not accessible in this offline review, so this comparison identifies code-level gaps and validates the fix locally, but does not verify the live environment values.
