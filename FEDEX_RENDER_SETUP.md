# Smart Handicrafts — FedEx fourth tab (sandbox-first)

This release adds the **FedEx Shipping** desktop/mobile tab to the original `public/index.html`, plus secure API routes in `server.js` through `fedex-integration.js`. The original AI Debate, Shipping Labels and Order Dashboard routes and content are retained. A **FedEx →** shortcut appears beside eligible Sales Orders in Order Dashboard.

## Render environment variables

You already configured the first six below. Please add the session secret before trying the new tab.

| Variable | Description |
|---|---|
| `FEDEX_MODE` | `sandbox` (default; keep until production approval) |
| `FEDEX_SHIPPING_CLIENT_ID` | Shipping project sandbox API key |
| `FEDEX_SHIPPING_CLIENT_SECRET` | Shipping project sandbox secret |
| `FEDEX_TRACKING_CLIENT_ID` | Tracking project sandbox API key |
| `FEDEX_TRACKING_CLIENT_SECRET` | Tracking project sandbox secret |
| `FEDEX_SANDBOX_ACCOUNT` | **India** sandbox shipping account, not the real business account |
| `PROFILE_SESSION_SECRET` | **Required:** a fresh, randomly generated string of at least 32 characters. Keep this private. Changing it signs everyone out. |

Recommended real sender information (optional but useful): `FEDEX_ORIGIN_CONTACT`, `FEDEX_ORIGIN_COMPANY`, `FEDEX_ORIGIN_PHONE`, `FEDEX_ORIGIN_EMAIL`, `FEDEX_ORIGIN_LINE1`, `FEDEX_ORIGIN_LINE2`, `FEDEX_ORIGIN_CITY`, `FEDEX_ORIGIN_STATE_CODE` (typically `DL` for Delhi), `FEDEX_ORIGIN_POSTAL`, `FEDEX_ORIGIN_COUNTRY=IN`. The form can also be edited manually, e.g., pickup from the actual warehouse rather than the FedEx billing address. Any preexisting `SHIP_FROM_*` settings are reused when appropriate.

For production **later**, after FedEx approval: set `FEDEX_MODE=production`; configure the separate production shipping/tracking IDs and secrets, real `FEDEX_ACCOUNT_NUMBER`, and finally `FEDEX_ENABLE_LIVE_ACTIONS=true` when authorized. Until that switch is enabled, the server blocks live label and pickup actions.

## How to deploy on Render

1. Commit/upload the included updated project files to the GitHub repository that your existing Render Web Service deploys from. Keep the existing Render Build and Start commands (`npm install`, `npm start`).
2. Add `PROFILE_SESSION_SECRET` and any origin/warehouse details in Render > your service > Environment. Redeploy to read the variables.
3. **Sign in again** to your Smart Handicrafts or SUDO profile. This release changes profile cookies to cryptographically signed sessions for security. The Accounts profile does not get access to FedEx.
4. Open the fourth **FedEx Shipping** tab. It should display `SANDBOX · Test only` and the state of both projects. Load a genuine Odoo Sales Order from the Order Dashboard or type a Sales Order reference.
5. Review recipient and sender addresses, choose **No lithium batteries** only if factually correct, enter package dimensions/weight, and click **Get live FedEx rates**. Rates may not appear for unsupported sandbox routes or locations.
6. Enter accurate commodity descriptions, quantities, USD (or other) customs unit values, HS codes, origin countries, and unit weights. FedEx's sandbox might return simulated rates/labels. Select a service and explicitly confirm **Create Label/AWB**.
7. Download the resulting PDF from shipment history, and separately confirm any **Pickup Request**. Tracking uses the second project. Do not assume sandbox tracking or pickup confirmation represents a real FedEx courier booking.

## Limitations and safety

- **Batteries:** this initial release deliberately rejects lithium battery shipments (contained, packed, standalone or unknown) from automated rate/label generation. Smart Handicrafts rechargeable kits and 18650 cells must not be mislabeled as battery-free. Dangerous-goods shipment support requires service/route authorization and compliant FedEx/IATA payloads, packaging, marking and documentation.
- **One package per shipment, one shipment per Sales Order:** adding another label for the same Sales Order is blocked until manual review. This protects against duplicate billable shipping transactions after timeouts. Split/multi-piece shipments are a future enhancement.
- **Customs:** The UI captures accurate commodities and sends them as Ship API customs clearance details. It does not independently upload a PDF commercial invoice via the Trade Documents Upload API, issue India export declarations, or calculate final import duty/tax charges; those may still require document/consignment checks in FedEx and customs systems. Customs values are explicitly entered; order total is not used as a substitute.
- **Rates:** Account-based FedEx quotes are estimates and may differ from invoices, particularly where pickup surcharges, duties or services vary. Pickup availability/cutoff restrictions are checked by FedEx when requesting; this first release does not present a separate Pickup Availability endpoint.
- **Odoo:** Sales Orders are read-only for FedEx operations. Creating a label does not update an Odoo picking, attach it to an invoice or automatically trigger shipment through Odoo. Odoo stock movement is unchanged.
- **Storage:** FedEx operation records and PDF labels are written under `./fedex-data` by default, which is ephemeral on standard Render instances. To keep history through restarts and deployments, attach a persistent Render disk and set `FEDEX_DATA_DIR` to its writable mounted directory. Do not treat ephemeral history as an authoritative shipping audit trail.
- **Production controls:** Even with production credentials, live mutations remain blocked unless `FEDEX_ENABLE_LIVE_ACTIONS=true`; the browser asks for separate confirmation of label and pickup actions. Shipping API and tracking credentials never go to the browser.
- **Secrets:** Keep `.env` and all credentials out of GitHub. Rotate/revoke any secret exposed outside Render.

## Tests

Run: `node --check server.js && node --check public/fedex.js && node --test tests/fedex.test.mjs`

Tests use **mock FedEx responses**, not real API credentials/network. They cover sample rate parsing, server-side battery/HS checks, test AWB label and pickup/tracking flows, and duplicate operation blocking. Real FedEx sandbox functionality can only be validated after deployment with your account.
