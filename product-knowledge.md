# Smart Handicrafts — Product Knowledge Base

Version: 2026-05-22
Use: AI product explanation, compatibility guidance, WhatsApp/Odoo Operator Hub, website chatbot, export-compliance support, CRM/sales automation, and handover support.

---

## Critical price source rule

This markdown file is **not a pricing source**.

For every price, slab, stock, website link, SKU commercial detail, quotation, or kit calculation, the AI must use:

1. `odoo-product-pricelist-authority.json` / `odoo-product-pricelist-export.json`
2. Live Odoo `product.template` and `product.pricelist.item` data, when available

If a price is not found in the Odoo pricing source, reply that the exact price needs team confirmation.

Do **not** use old markdown prices, catalogue text, screenshots, or memory as final pricing. Do **not** quote a complete kit price by using only the driver price. Complete kit pricing must come from a kit SKU or from per-component Odoo prices.

---

## Important bot rules

- Reply like a Smart Handicrafts sales/support employee: short, direct, practical.
- Use this file only for product explanation, compatibility, product selection, policy guidance, workflow guidance, and handover logic.
- Never invent price, discount, MOQ, lead time, warranty, stock, dispatch commitment, certification, HS code, or legal compliance.
- Customer's latest correction wins over old AI memory.
- If the customer says “maine ye nahi pucha / abhi to bataya / wrong / galat,” acknowledge and correct immediately.
- Ask only one clear question at a time.
- Do not restart the full decision tree if facts are already confirmed.
- For final commercial confirmation, special discount, bulk negotiation, sample order finalization, or exact quotation, hand over to sales.
- For custom electronics, new development, risky electrical compatibility, or special mechanical integration, hand over to technical.
- In Operator Hub/WhatsApp chat mode, do not use “Sources: [x][y]” in customer replies unless specifically needed. Keep replies natural.

---

# Company overview

Brand Name: Smart Handicrafts
Business Model: B2B tech modules and integration support for artisans, exporters, lighting brands, and OEMs.
Mission: Empower Indian artisans by blending traditional craftsmanship with modern technology.
Positioning: Plug-and-play smart electronics for table lamps, decorative lighting, handicrafts, and export-oriented products.

## Contact and address

- Address: A-23, 1st Floor, Okhla Phase-1, New Delhi, India, 110020
- Phone: +91-9315155031
- Email: care@smarthandicrafts.com
- Website: www.smarthandicrafts.com

---

# Safety and compliance guidance

Smart Handicrafts focuses on component-level safety and reliability.

## Component-level standards referenced

- CE, UKCA, UL where applicable
- BIS where applicable
- RoHS where applicable
- LED drivers/modules are designed around relevant safety benchmarks such as IEC 61347 and IEC 62031 where applicable.

## General testing orientation

- Thermal management
- Electrical stability
- Controlled emissions
- Photobiological safety orientation where applicable

## Compliance guardrails

- Component-level compliance does not automatically certify the customer's final lamp.
- Final lamp compliance depends on enclosure, wiring, battery pack construction, installation quality, heat management, mechanical design, and testing.
- If customer asks for certificates, test reports, or country-specific compliance, collect product SKUs and route to support/sales.
- Do not declare a final HS code. Recommend confirmation with customs broker/CHA.
- For legal/regulatory uncertainty, recommend validation with a compliance officer or testing lab.

---

# Product selection decision tree

Ask only missing details:

1. Application: table lamp, wall lamp, floor lamp, decorative product, strip light, DOB board, candle warmer, etc.
2. Power type: rechargeable, USB powered, direct DC/AC-DC, or battery-only.
3. LED type: single COB, dual COB / 3-colour, strip LED, DOB, filament, flame LED, fairy light.
4. Wattage/load: 0.5W, 2W, 3W, 5W, 7W, strip length, etc.
5. Colour type: single colour, warm/cool dual CCT, 3-colour, RGB/RGBCW/RGBCCT.
6. Quantity: sample, small batch, bulk.
7. Market/destination: India or export, only if compliance/shipping matters.
8. Timeline: prototype, pilot, production, urgent sample, etc.

Do not ask all questions at once. Ask only the next missing question needed to recommend correctly.

---

# High-confidence recommendation logic

## Rechargeable drivers

- Single COB up to 5W rechargeable: `AS-B-201-SLD`
- Dual/3-colour COB rechargeable: `AS-B-202-DLD`
- Strip/DC bulb rechargeable standard charging: `AS-B-204-LSD`
- Strip/DC bulb rechargeable fast charging: `AS-B-205-LSD`

## USB powered drivers

- USB powered single COB: `AS-U-101-SLD`
- USB powered dual/3-colour COB: `AS-U-102-DLD`
- USB powered strip/DC bulb: `AS-U-103-LSD`

## Rechargeable DOB

- 115mm 3-colour rechargeable DOB: `AS-B-206-115-DLD`
- 75mm 3-colour rechargeable DOB: `AS-B-206-75-DLD`
- 55mm 3-colour rechargeable DOB: confirm exact Odoo SKU before quoting.

## Lowest cost / LC

- LC series is for cost-sensitive products and faster assembly.
- LC composition and price must be confirmed from Odoo by exact SKU before quoting.

---

# Important product rules

## Driver 201

`AS-B-201-SLD` is a rechargeable single-colour / single-output LED driver.

Use it for:
- 3W single COB
- 5W single COB
- single-colour rechargeable lamp applications

Do not use it for:
- dual CCT / 3-colour control
- strip LED / 12V-24V strip applications
- two separate independently controlled LEDs

## Driver 202

`AS-B-202-DLD` is a rechargeable dual LED / 3-colour driver.

Use it for:
- dual COB / warm-cool LED setup
- 3-colour lamp control
- touch sequence where LED1 / LED2 / both can be controlled depending on wiring/design

Normal dual COB discussion should focus on available Odoo/catalogue products such as 3W dual and 5W dual. Do not assume a generic 4W dual COB option unless a specific Odoo product/kit SKU is matched.

## Driver 204 vs 205

`AS-B-204-LSD` = rechargeable strip/DC bulb driver, normal/standard charging.
`AS-B-205-LSD` = rechargeable strip/DC bulb driver, fast-charging option.

Both are for strip/DC bulb applications and can support 12V/24V output families depending on application.

## USB drivers

USB drivers do not use batteries.

- `AS-U-101-SLD` = USB powered single-colour driver
- `AS-U-102-DLD` = USB powered dual/3-colour driver
- `AS-U-103-LSD` = USB powered strip driver

## LC series

LC series is for cost-sensitive products and fast assembly.

LC set and normal driver are different concepts:
- Normal driver price is driver-only.
- LC set may include driver, LED, battery, and connector wire depending on exact SKU.
- Always confirm exact LC SKU from Odoo before quoting composition or price.
- Do not treat LC set price as the price for all normal non-LC kit combinations.
- Do not present 4W dual COB as a normal standalone dual COB option unless Odoo has an exact product/kit match.

## Battery recommendation

For normal rechargeable kits, recommend 2600mAh first.
For LC/cost-sensitive kits, 1200mAh can be considered.
5200mAh is a larger dual-cell sleeve pack and should not be recommended first unless longer backup or bigger size is requested.

Sleeve battery is easier to install because it is a ready pack with wire/JST.
Without-sleeve battery requires holder/extra wiring and more fitting planning.

## Complete kit pricing rule

For a complete kit, AI must either:
- use a specific Odoo kit SKU, or
- calculate per-component price from Odoo pricing data.

Never say “complete kit price” by using the driver-only price.

Example normal rechargeable 3W single COB kit components:
- Driver 201
- 3W COB LED
- 2600mAh battery or 2600mAh sleeve battery
- JST wire
- optional touch nut, USB-C panel mount, lens, holder, etc.

The exact price must be fetched from Odoo pricing JSON/live Odoo.

---

# Product categories

## 1. Rechargeable LED drivers

### AS-B-201-SLD — Rechargeable 1 Colour Touch Dimmable Driver

Type: Rechargeable LED driver, single colour
Use: single COB lamps

Key features:
- Single-colour rechargeable LED driver
- Supports LED load up to 5W
- Touch-based dimming
- Plug-and-play assembly
- Suitable for table lamps, wall lamps, and decorative lamps where single-colour LED is needed

Best paired with:
- 3W single COB
- 5W single COB
- 2600mAh battery for standard rechargeable kits
- JST wire and touch accessories as required

Pricing: Use Odoo pricing source only.

### AS-B-202-DLD — Rechargeable 3 Colour / Dual LED Driver

Type: Rechargeable dual LED / 3-colour driver
Use: warm/cool dual COB, 3-colour lamp setup

Key features:
- Three-colour / dual LED rechargeable driver
- Supports dual LED use-cases
- Touch-based dimming
- Plug-and-play assembly

Best paired with:
- 3W dual COB
- 5W dual COB
- suitable battery and wiring as per design

Pricing: Use Odoo pricing source only.

### AS-B-204-LSD — Rechargeable Strip/DC Bulb Driver

Type: Rechargeable strip/DC bulb driver
Use: LED strip or compatible 12V/24V DC LED applications

Key features:
- 12V/24V output family
- Touch-based dimming
- Plug-and-play assembly
- Normal/standard charging option

Pricing: Use Odoo pricing source only.

### AS-B-205-LSD — Rechargeable Strip/DC Bulb Driver, Fast Charging

Type: Rechargeable strip/DC bulb driver
Use: strip/DC bulb applications where fast charging is preferred

Key features:
- 12V/24V output family
- Fast charging support
- Touch-based dimming
- Plug-and-play assembly

Pricing: Use Odoo pricing source only.

---

## 2. USB powered LED drivers

### AS-U-101-SLD — USB Powered 1 Colour Driver

Use: single COB USB powered lamps.
Does not use battery.
Best paired with 3W/5W single COB, USB cable, USB-C panel mount connector if required.

Pricing: Use Odoo pricing source only.

### AS-U-102-DLD — USB Powered Dual LED Driver

Use: dual COB / 3-colour USB powered lamps.
Does not use battery.

Pricing: Use Odoo pricing source only.

### AS-U-103-LSD — USB Powered Strip Driver

Use: strip LED / DC bulb type applications from USB input.
Does not use battery.

Pricing: Use Odoo pricing source only.

---

## 3. Rechargeable DOB boards

DOB = LED and driver on board.

Use when customer wants a compact integrated LED-board solution instead of separate driver + LED.

Typical variants:
- 115mm 3-colour DOB
- 75mm 3-colour DOB
- 55mm 3-colour DOB

Ask diameter/brightness/application before recommending.

Pricing: Use Odoo pricing source only.

---

## 4. COB LEDs

### Single COB LEDs

Typical options:
- 0.5W COB
- 2W COB
- 3W COB
- 5W COB
- 12V 3W COB
- 24V 5W COB

For rechargeable 201 driver:
- 3V 3W or 3V 5W COB are common choices.

For strip/DC bulb driver:
- check voltage compatibility.

Pricing: Use Odoo pricing source only.

### Dual COB LEDs

Dual COB means warm/cool or dual-output LED setup for 3-colour/dual CCT control.

Typical options:
- 3W dual COB
- 5W dual COB
- possible size variants depending on Odoo SKU

Use with:
- rechargeable `AS-B-202-DLD`
- USB `AS-U-102-DLD`

Do not assume 4W dual COB unless exact Odoo SKU/kit is matched.

Pricing: Use Odoo pricing source only.

---

## 5. COB LED strips

Typical families:
- 3mm COB strip
- 5mm COB strip
- 8mm COB strip
- 10mm CCT strip
- RGB / RGBCW / RGBCCT strip
- 12V / 24V variants

For rechargeable strip applications:
- use `AS-B-204-LSD` for normal charging
- use `AS-B-205-LSD` for fast charging

For USB strip applications:
- use `AS-U-103-LSD`

Ask strip width, voltage, colour type, and length.

Pricing: Use Odoo pricing source only.

---

## 6. Decorative LEDs

Includes:
- Flame LED
- Fairy lights
- decorative low-voltage lighting modules

Ask input voltage, size, colour, and application.

Pricing: Use Odoo pricing source only.

---

## 7. Flexible filament LEDs

Includes flexible filament LED lengths/voltages such as 3V, 12V, and 24V families.

Ask length, voltage, colour temperature, and lamp design.

Pricing: Use Odoo pricing source only.

---

## 8. Batteries

Typical rechargeable battery families:
- 1200mAh Li-ion
- 2600mAh Li-ion without sleeve
- 2600mAh Li-ion with sleeve
- 5200mAh dual pack sleeve
- other capacities as per Odoo

Guidance:
- Recommend 2600mAh first for most standard rechargeable lamp kits.
- Recommend 1200mAh for LC/cost-sensitive products.
- Recommend 5200mAh only for bigger size or longer backup needs.
- Sleeve pack is easier for installation; without-sleeve requires holder/wiring.

Pricing: Use Odoo pricing source only.

---

## 9. Battery holders

Includes:
- 18650 battery holder
- AA battery holder
- AAA battery holder
- parallel holder variants where available

Ask battery type and lamp fitting space.

Pricing: Use Odoo pricing source only.

---

## 10. USB cables

Includes:
- USB A to C
- USB C to C
- braided cables
- cables with switch
- black/white/golden variants

Ask required connector type, colour, length, and quantity.

Pricing: Use Odoo pricing source only.

---

## 11. USB-C panel mount connectors

Includes:
- black without indicator
- black with indicator
- white without indicator
- transparent without indicator
- push-fit / threaded variants
- dual USB variants

Ask panel thickness, colour, indicator requirement, fitting type, and cable length.

Pricing: Use Odoo pricing source only.

---

## 12. Switches

Includes:
- push button switch
- round push button switch
- rocker switch
- round rocker SPST switch

Ask mounting hole, design, current/load, and application.

Pricing: Use Odoo pricing source only.

---

## 13. Add-ons and accessories

Includes:
- LED lenses: clear/frosted
- touch sensor lug
- brass touch nut
- JST wire
- metal/plastic USB-C enclosures
- LED holders and shade rings

Compatibility:
- Lenses and holders are usually paired with 3W/5W single and dual COBs.
- JST wire length can be customized; confirm length before quotation.
- LED holders depend on lamp material, mounting hole, shade type, and mechanical design.

Pricing: Use Odoo pricing source only.

---

# Product pairings and compatibility

## Rechargeable single-colour table lamp

Typical setup:
- `AS-B-201-SLD`
- 3W or 5W single COB
- 2600mAh battery
- JST wire
- touch nut/sensor
- optional USB-C panel mount connector
- optional holder/lens

Ask only missing detail:
- wattage/brightness
- battery sleeve preference
- quantity

## Rechargeable dual/3-colour table lamp

Typical setup:
- `AS-B-202-DLD`
- 3W dual or 5W dual COB
- 2600mAh battery
- JST wire
- touch accessories

Ask only missing detail:
- 3W dual or 5W dual
- quantity

## USB powered single-colour lamp

Typical setup:
- `AS-U-101-SLD`
- 3W or 5W COB
- USB cable
- USB-C panel mount connector if needed

No battery.

## USB powered dual/3-colour lamp

Typical setup:
- `AS-U-102-DLD`
- 3W or 5W dual COB
- USB cable
- USB-C panel mount connector if needed

No battery.

## Rechargeable strip lamp

Typical setup:
- `AS-B-204-LSD` normal charging or `AS-B-205-LSD` fast charging
- compatible 12V/24V strip
- suitable battery setup
- panel mount/connector/wire as required

Ask strip voltage, strip length, and fast charging requirement.

---

# Integration guides: website, commerce, ERP

## Hardware control APIs

Smart Handicrafts modules are plug-and-play electronics. No public device-control API is provided for standard drivers/modules.

## E-commerce compatibility

- Shopify: suitable for listing/catalog + lead capture + documentation request flows
- WooCommerce: suitable for listing/catalog
- Amazon/marketplaces: suitable for component selling if listing compliance and battery shipping rules are handled properly
- ERP/OMS/WMS: Odoo is compatible for SKUs, price slabs, and CRM workflows

## Odoo usage guidance

Suggested approach:
1. Create products by SKU.
2. Maintain quantity slabs in Odoo pricelists.
3. Use CRM for lead capture: application, wattage, power type, colour, quantity, destination country.
4. If managing BOM bundles, create kit products or use BOM/manufacturing where applicable.

Important Odoo fields:
- `default_code` = SKU / internal reference
- `name` / `display_name` = product name
- `list_price` = base sales price
- `qty_available` = stock signal
- `website_url` = product page path
- `pricelist_rule_ids` = linked quantity pricing rules
- `description_sale` = sales description where available
- `categ_id` = product category

## Zapier / Make automation ideas

- Website form to CRM lead in Odoo
- Certificate request form to email + CRM activity
- Quote request form to opportunity + assigned sales owner
- Post-sales support ticket to service inbox routing

---

# Policies and company FAQs

Policy answers must be treated as general guidance and should be confirmed for formal quotation or legal use.

## Shipping policy

- Dispatch time depends on order quantity and stock availability.
- Samples generally ship faster than bulk.
- Export shipments depend on documentation and courier regulations, especially battery shipments.

## Returns policy

- Returns are generally applicable for manufacturing defects or wrong item supplied.
- Custom or special assembly orders may be non-returnable; confirm case-by-case.

## Warranty / SLA

- Technical queries: aim to respond within 1–2 business days.
- Production / dispatch SLA: depends on quantity and planning; confirm with support/sales.

## Data / privacy

- Customer data is used for quotations, support, and documentation sharing.
- Do not promise anything beyond the company's formal policy if the customer asks legal/privacy-specific questions.

---

# Compliance and export operational guidance

## What the bot can say

- Component-level certifications and standards are referenced for applicable products.
- Final product compliance depends on final lamp design and testing.

## Certificate request workflow

If user asks for CE/UKCA/UL/RoHS documents, collect:
- Name
- Company
- Email
- Phone
- Product SKUs required
- Destination country

Then route to sales/support.

## HS codes

HS codes depend on product configuration and packaging. The bot must not declare a final HS code. Recommend confirmation with customs broker/CHA.

## Country-specific restrictions

- Lithium-ion shipping rules vary by courier and destination.
- Some marketplaces require additional battery compliance.

## Export documents commonly needed

- Commercial invoice
- Packing list
- Certificate of origin if required
- Requested component certificates if applicable

## Incoterms

- EXW can be typical
- FOB/CIF only if agreed in quotation

Do not promise Incoterms without quotation confirmation.

---

# Sales and implementation playbooks

## Qualification questions

Ask only missing fields, not all at once:

- Application: table lamp, wall lamp, DIY, hospitality, decorative, strip
- LED load: 0.5W, 2W, 3W, 5W, 7W, etc.
- Power input: USB or rechargeable
- Colour: 1-colour or 3-colour
- Quantity: sample, 60+, 100+, 500+, 1000+, etc.
- Destination market: India or export
- Timeline: prototype, pilot, production

## Suggested package by customer type

- Artisan / DIY: LC series or simple plug-and-play kit depending on budget
- Exporter: driver + 2600mAh battery + accessories + documentation request workflow
- OEM: bundle recommendation + technical review + consistent BOM/supply planning
- Hospitality/project customer: clarify timeline, quantity, design, compliance and dispatch needs

## Common objections

- “China cheaper”: highlight reliability, support, compliance orientation, plug-and-play, consistent BOM supply, and local technical help.
- “Need custom module”: route to technical review.
- “Need certificates”: route to document request workflow.
- “Need exact price/discount”: route to Odoo pricing or sales handover.

---

# Sales automation playbook

## Lead stages

1. Inquiry
2. Qualified
3. Technical Review
4. Quote Sent
5. Negotiation
6. Closed Won / Closed Lost

## Qualification rules

- Capture at least application, power type, colour requirement, and quantity bracket before a proper quote.
- Export query should trigger compliance/document workflow if needed.

## ICP tiers

- Tier A: artisan / low volume
- Tier B: exporter / medium volume
- Tier C: OEM / high volume + repeat
- Tier D: hospitality/project/bulk with timelines

## Required CRM fields for handoff

- Lead source: website, WhatsApp, referral, marketplace, etc.
- Name, company, phone, email
- Country and city
- Application type
- LED wattage and colour type
- Power type: USB/rechargeable/direct
- Quantity bracket
- Recommended SKU bundle
- Compliance/document request
- Next action: call, quote, sample dispatch, technical review

## Proposal / quotation workflow

1. Confirm requirements: wattage, power type, colour type
2. Recommend SKUs / bundle
3. Confirm quantity slab
4. Confirm destination and shipping method if needed
5. Quote through Odoo/live pricing and sales confirmation

---

# Automation intake template

Ask only missing fields:

- customer_name
- company_name
- email
- phone_or_whatsapp
- application
- power_type
- led_type
- wattage
- color
- quantity_bracket
- destination_country, if export
- timeline

For automation mode, structure internal output as:

```json
{
  "workflow": "quote_intake",
  "lead_stage": "Inquiry|Qualified|Technical Review",
  "recommended_skus": [],
  "bundle_suggestion": "",
  "missing_fields": [],
  "pricing_status": "odoo_required|found|needs_confirmation",
  "policy_status": "current|review_required",
  "compliance_status": "component_level_only|needs_lab_validation",
  "disclaimer_required": true,
  "next_action": "request_details|send_quote|book_call|handover",
  "support_contact": "care@smarthandicrafts.com"
}
```

---

# Handover rules

## Assign to sales / Khushagra

Use for:
- price confirmation
- final quotation
- special discount
- bulk negotiation
- sample order finalization
- stock/dispatch commitment
- existing product commercial follow-up

Customer-facing wording:
“Khushagra ji hamari sales team se hain. Woh aapko quotation/price details confirm kar denge. Agar aapko kisi aur product mein help chahiye ho to bata sakte hain.”

After final handover reply, AI should wait before replying again unless the customer starts a new topic.

## Assign to technical / Vibhu

Use for:
- custom PCB/driver
- new feature development
- unknown electrical compatibility
- high-risk battery/charger/safety questions
- wiring design needing review
- special mechanical integration

---

# Conversation behaviour

## Broad product need

Examples:
- “I need some products from you”
- “Mujhe lamp ke liye electronics chahiye”
- “Need LED”

Reply:
“Ji, aapko kis type ka product chahiye — LED, driver, battery, strip LED, panel mount connector, ya complete lamp kit? Agar lamp type/wattage/quantity pata ho to woh bhi bata dijiye.”

## Difference question

If customer asks “difference / kya antar hai / farak kya hai,” interpret based on the last AI question/current topic.

Common difference topics:
- 3V vs 12V COB
- sleeve vs without-sleeve battery
- 204 vs 205 driver
- single-colour vs 3-colour
- COB vs strip LED

Do not ask “which difference?” if the previous context is clear.

## Sample request

If setup is already clear, do not ask again what sample. Confirm the setup and ask whether to proceed with quotation/quantity.

## Correction

If customer corrects AI, immediately acknowledge and correct:
“Ji, sorry, aap sahi keh rahe hain. Main previous context par wapas aa raha hoon...”

## Model fallback

If Gemini/model is unavailable, use deterministic fallback based on active context. Avoid generic restart questions if the customer already gave details.

---

# Final pricing guardrail

The AI must never answer a price from this markdown file.

For every price/rate/quotation reply:
1. Match the product/SKU from the customer message.
2. Use Odoo pricing JSON/live Odoo.
3. Apply quantity slab from Odoo `pricelist_rules`.
4. If complete kit, use kit SKU or add per-component prices from Odoo.
5. If product is not found, say price needs confirmation and hand over to sales.
