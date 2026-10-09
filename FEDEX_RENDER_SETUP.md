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

Recommended real sender information: `FEDEX_ORIGIN_CONTACT`, `FEDEX_ORIGIN_COMPANY`, `FEDEX_ORIGIN_PHONE`, `FEDEX_ORIGIN_EMAIL`, `FEDEX_ORIGIN_LINE1`, `FEDEX_ORIGIN_LINE2`, `FEDEX_ORIGIN_CITY`, `FEDEX_ORIGIN_STATE_CODE` (typically `DL` for Delhi), `FEDEX_ORIGIN_POSTAL`, `FEDEX_ORIGIN_COUNTRY=IN`. Use the **actual warehouse pickup address**, not the FedEx account billing address unless they are identical. The form can also be edited manually.

### Address + delivery-line importer correction

The FedEx import route now reads ISO country and state codes directly from Odoo `res.country` / `res.country.state` instead of treating display names as valid codes. Czech partner addresses stored entirely in Street (e.g. `Hrobce 142, 411 83 Hrobce`) are separated into Street, City, and ZIP **only if the pattern is unambiguous**. Other incomplete addresses remain for review; the app never writes the normalized fields back to Odoo.

The importer excludes Odoo `is_delivery` order lines, service-type products, section/note lines, and obvious delivery/fee fallback lines from FedEx customs commodities. It now suggests the tax-exclusive, discounted *unit price from each sales order line* (`price_subtotal / quantity`) rather than using catalog price or order total. It also reads variant/template weight, HS code and country of manufacture **where those fields exist and are populated in Odoo**. Unknown, invalid or zero customs values are left blank; they must be entered manually. The suggested sale price is not certified to be the correct customs value. All fields remain editable and are re-validated before FedEx rates or labels. Neither Odoo order nor stock records are changed.

**FedEx origin fix:** older `SHIP_FROM_LINE2` may contain a different location (e.g. Mayapuri) than `SHIP_FROM_LINE1` (e.g. Okhla). To avoid silently merging these locations, the FedEx workspace now uses **only `FEDEX_ORIGIN_LINE2`** for its second street line (blank unless explicitly set). Configure the verified pickup address in Render using the `FEDEX_ORIGIN_*` variables above. This does **not** change the default-from address in the existing Label Maker.

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

### FedEx rate quotation currency (2026-10-09 patch)

When loading a Sales Order, the FedEx workspace passes its Odoo currency (for example `USD`) to the rates endpoint. The server asks FedEx for `rateRequestType: ["PREFERRED", "LIST"]` and `requestedShipment.preferredCurrency: "USD"`. It chooses the **account-specific preferred-currency** rate when FedEx returns one. If FedEx only returns EUR or another currency, the dashboard displays the **actual currency returned**, with a clear warning, rather than relabeling a EUR amount as USD. Rate currency is separate from the customs declaration currency and from the currency FedEx ultimately bills. The existing Ship API and pickup routes are unchanged. No extra Render variables are required.



### FedEx Pre-label Check and Czech destination state fix (2026-10-09)

- The FedEx order importer now **clears a stale Odoo state code for Czech (`CZ`) recipients**, so `US` or another unrelated region is never copied into the FedEx request for Hrobce. If a user manually enters a Czech state, server-side validation blocks label creation and asks them to leave it blank. This fixes the **request data** issue; a FedEx sandbox label could still contain FedEx-generated sample placeholders, so always inspect the returned PDF.
- After receiving rates, choose a service, review and tick the verification checkbox, then press **Run pre-label check**. The server checks sender/recipient fields, valid country codes, required customs declaration fields, battery blocking, commodity-vs-parcel weight, selected service and order reference. Missing/mismatched items appear in the results.
- Label creation is **blocked** without a valid server-issued approval token, valid for 10 minutes and cryptographically bound to the exact shipment data, service and reviewer confirmation. Changes after checking or expiration require another check. An existing prior sandbox/production shipment attempt for that order is also blocked.
- For returned FedEx PDF labels, the server checks the PDF header/trailer and basic file size. This does **NOT** verify barcode scan quality, all address fields printed on the FedEx template, 4x6 page cropping, customs legality, or physical shipment eligibility. Users must open and visually verify the generated document at actual scale before printing. `TEST LABEL - DO NOT SHIP` sandbox documents may not be used for actual shipping.
- No additional Render secrets, environment variables, dependencies or production permissions are needed. Keep `FEDEX_MODE=sandbox` until FedEx production validation has been completed.

## October 9 commercial-invoice and pre-label release

- The fourth tab now includes **Linked customer invoice & FedEx commercial invoice** immediately after sales order loading.
- Only `posted` `out_invoice` documents referenced by `sale.order.invoice_ids` count. If there are no posted invoices, the label action is blocked and the operator is instructed to create/post the Odoo invoice first. If several posted invoices exist, the operator must select one.
- The commercial-invoice generator uses *linked Odoo account.move.line* goods quantities, discounted untaxed line amounts and invoice currency, not the manually typed order total. Shipping/convenience-fee service lines are excluded. HS classification, origins and weights still require operator verification.
- **Download customs invoice PDF** makes a separate printable exporter-issued commercial invoice (not an Odoo invoice template or FedEx AWB). The same commercial invoice is also attached to the FedEx shipment's download links on successful label generation. In sandbox it bears a clear test warning.
- Pre-label check verifies a genuine posted invoice on the server and compares physical items, quantities, currencies and values to customs lines. Any mismatch blocks the label. Preflight approval is still tied to the exact shipment data and expires after 10 minutes.
- The provided `FedEx-794881292586.pdf` is an AWB/label, **not a commercial invoice design reference**. The included exporter commercial invoice uses a clean professional layout. Upload a FedEx commercial-invoice template if you require an exact visual match.
- Printing the PDF and uploading it as FedEx Electronic Trade Documents are different operations. **Automatic ETD upload is not implemented in this release**. Use the downloaded invoice for manual paperwork until separately validated.
- There are no new Render environment variables. This uses the existing Odoo account connection and `pdfkit` dependency from `package.json`. All FedEx API keys remain on the server.
- The server must have permission to read the linked Odoo invoice (`account.move`, `account.move.line`). PDF invoice generation and real Odoo fields must be tested after deployment; unit tests use stubs, not a live Odoo/FedEx account.


**Sender address regression fix:** The FedEx tab now retries `GET /api/fedex/config` whenever an order is loaded, because the initial request may happen before login. It fills only empty sender fields and never erases manual corrections. Existing `SHIP_FROM_*` variables still supply sender defaults, including `SHIP_FROM_STATE`; `FEDEX_ORIGIN_*` override them. Legacy `SHIP_FROM_LINE2` is intentionally not carried into FedEx because prior values combined Okhla and Mayapuri in a single street address; use `FEDEX_ORIGIN_LINE2` only for a verified second street line. An incomplete sender configuration is highlighted rather than silently treated as ready.
