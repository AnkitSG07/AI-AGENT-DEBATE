# Smart Handicrafts® — Product Knowledge Base (2026)
Version: 2026-03
Last_Updated: 2026-03-02
Use: Gemini RAG website chatbot + B2B sales assistant + export compliance assistant + sales automation copilot.

---

## IMPORTANT BOT RULES
- Answer ONLY using the RETRIEVED KNOWLEDGE snippets provided at runtime.
- If a detail is not in retrieved snippets, say you don’t have it and suggest contacting support.
- Never guess certifications, approvals, test reports, HS codes, or legal compliance for a customer’s final product.
- Never invent pricing, discounts, MOQ, lead time, warranty, or contractual terms.
- If pricing/policies might be stale: say “Confirm latest with support.”
- End responses with: "Sources: [x][y]" based on retrieved snippet numbers.

---

# Company Overview
Brand Name: Smart Handicrafts®  
Business Model: B2B tech-modules + integration support for artisans, exporters, lighting brands, and OEMs.  
Mission: Empower Indian artisans by blending traditional craftsmanship with modern technology; train, educate, and support tech integration into handcrafted products.  
Positioning: Tech-enabled lighting modules for wireless table lamps and DIY lighting projects.

## Contact & Address
- Address: A-23, 1st Floor, Okhla Phase-1, New Delhi, India, 110020
- Phone: +91-9315155031
- Email: care@smarthandicrafts.com
- Website: www.smarthandicrafts.com

---

# Safety & Compliance (Component-Level)
Validity: stable_guidance (review yearly)

Smart Handicrafts prioritizes safety and reliability with compliance to international standards.

## Claimed/Referenced Standards (Component-level)
- CE, UKCA, UL (component-level where applicable)
- BIS (India) where applicable
- RoHS
- LED drivers/modules designed to meet safety benchmarks including IEC 61347 and IEC 62031.

## General Testing Orientation
- Thermal management
- Electrical stability
- Controlled emissions
- Photobiological safety orientation (as referenced across product range)

## Compliance Assistant Guardrails
- Always clarify: component certifications support export readiness, but end-product compliance depends on final lamp design, enclosure, wiring, battery pack construction, and testing lab evaluation.
- For any legal/regulatory uncertainty: recommend validation with a compliance officer or testing lab.
- If user asks for a specific certificate or test report number: ask them to request documents via support.

---

# How to Choose the Right Driver (Quick Decision Tree)
Validity: stable_logic (review quarterly)

Ask the user:
1) LED type: COB / Dual COB / Strip / DOB board  
2) Power: USB powered or Rechargeable  
3) Load (watts): 0.5W / 2W / 3W / 5W / 7W etc.  
4) Color: 1-color or 3-color (dual CCT / warm-white / etc.)  
5) Quantity: Sample / 60+ / 100+ / 500+ / 1000+ (or sets)  
6) Market: India / Export (EU/UK/US/other)

## Recommendation logic (high-confidence)
- Single COB up to 5W (rechargeable): AS-B-201-SLD
- Dual/3-color COB up to 5W dual (rechargeable): AS-B-202-DLD
- Strip/DC bulb (rechargeable): AS-B-204-LSD or AS-B-205-LSD
- USB powered single COB: AS-U-101-SLD
- USB powered dual/3-color: AS-U-102-DLD
- USB strip driver: AS-U-103-LSD
- Lowest cost bundle for cost-sensitive products: LC Sets

---

# Product Categories Index
1) Rechargeable LED Drivers  
2) Rechargeable Strip/Dimmer Drivers  
3) LC Series Sets (Driver + LED + Battery)  
4) USB Powered LED Drivers  
5) Rechargeable DOB (Driver on Board)  
6) DC LED COB (Single)  
7) Dual LED COB  
8) COB LED Strip  
9) Decorative LEDs (Flame LED, Fairy Lights)  
10) Flexible Filament LEDs  
11) Batteries (Li-ion 18650)  
12) Battery Holders  
13) USB Cables  
14) USB-C Panel Mount Connectors  
15) Switches  
16) Add-ons & Accessories (lens, touch parts, wires, enclosures, holders)

---

# CANONICAL SKU RULE (FOR RETRIEVAL)
- Each SKU should appear only once in this file.
- If catalog uses the same label for variants (example: 12V vs 24V), we create a canonical variant SKU and note alias.

---

# 1) Rechargeable LED Drivers (Touch Dimmable)

## SKU: AS-B-201-SLD — Rechargeable 1 Colour Touch Dimmable Driver
Type: Rechargeable LED driver, 1 color  
Key features:
- Single-color rechargeable LED driver
- Supports LED load up to 5W
- Touch-based dimming control
- Plug-and-play design for easy assembly
- Best-in-class performance and reliability  
Best paired with:
- 3W LED COB
- 5W LED COB  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample: ₹250
- 60+: ₹200
- 100+: ₹163
- 500+: ₹125
- 1000+: ₹99

## SKU: AS-B-202-DLD — Rechargeable 3 Colour Touch Dimmable Driver
Type: Rechargeable LED driver, 3 color / dual  
Key features:
- Three-color rechargeable LED driver
- Supports LED load up to 5W Dual
- Touch-based dimming control
- Plug-and-play design for easy assembly
- Versatile driver for multi-CCT / dual LED use-cases  
Best paired with:
- 2 x 3W LED COB
- 2 x 2W LED COB  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample: ₹250
- 60+: ₹200
- 100+: ₹163
- 500+: ₹125
- 1000+: ₹99

---

# 2) Rechargeable Strip / DC Bulb Drivers (Touch Dimmable)

## SKU: AS-B-204-LSD — LED Strip Dimmer Driver (Rechargeable)
Type: Rechargeable strip/DC bulb driver  
Key features:
- Supports 12V/24V output
- Best suitable for ~30cm strip length (typical use-case)
- Touch-based dimming control
- Plug-and-play design  
Best paired with:
- Strip LEDs
- 12V 3W LED COB  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample: ₹255
- 60+: ₹205
- 100+: ₹168
- 500+: ₹130
- 1000+: ₹104

## SKU: AS-B-205-LSD — LED Strip Dimmer Driver (Rechargeable, Fast Charging)
Type: Rechargeable strip/DC bulb driver (enhanced)  
Key features:
- Supports 12V/24V output
- Supports fast charging
- Touch-based dimming control
- Plug-and-play design  
Best paired with:
- Strip LEDs
- 24V 5W LED COB (and similar)  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample: ₹325
- 60+: ₹260
- 100+: ₹211
- 500+: ₹163
- 1000+: ₹130

---

# 3) LC Series Sets (Cost-Optimized Bundles)
Definition: Each LC set includes LED driver + LED + battery + wire connector.  
Target customers: cost-sensitive products, fast assembly, easy sourcing.

## SKU: AS-B-201-SLD-LC — Rechargeable 1 Colour LC Set
Key features:
- Single-color rechargeable LED driver
- Supports LED load up to 3W
- Touch dimming
- Plug-and-play  
Set contains:
- LED driver + 2W LED + 1200 mAh Li-ion battery + connector wire  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample Set: ₹250
- 2000+ Sets: ₹150

## SKU: AS-B-202-DLD-LC — Rechargeable 3 Colour LC Set
Key features:
- Three-color rechargeable LED driver
- Supports up to 5W (dual)
- Touch dimming
- Plug-and-play  
Set contains:
- LED driver + 4W dual LED (2W+2W) + 1200 mAh Li-ion battery + connector wire  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample Set: ₹250
- 2000+ Sets: ₹150

---

# 4) USB Powered LED Drivers (Touch Dimmable)

## SKU: AS-U-101-SLD — USB-C 1 Colour USB Powered Touch Dimmable Driver
Key features:
- Single-color USB powered LED driver
- Supports LED load up to 5W
- Touch dimming
- Plug-and-play  
Best paired with:
- 3W LED COB
- 5W LED COB  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample: ₹150
- 60+: ₹120
- 100+: ₹98
- 500+: ₹83
- 1000+: ₹74

## SKU: AS-U-102-DLD — USB-C 3 Colour USB Powered Touch Dimmable Driver
Key features:
- Three-color USB powered LED driver
- Supports 5W dual
- Touch dimming
- Plug-and-play  
Best paired with:
- 3W dual LED
- 5W dual LED  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample: ₹175
- 60+: ₹140
- 100+: ₹114
- 500+: ₹96
- 1000+: ₹86

## SKU: AS-U-103-LSD — USB-C Strip Driver (USB Powered Touch Dimmable Driver)
Key features:
- For strip/DC bulb use
- Supports 12V/24V output
- Touch dimming
- Plug-and-play  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample: ₹175
- 60+: ₹140
- 100+: ₹114
- 500+: ₹96
- 1000+: ₹86

---

# 5) Rechargeable DOB (Driver On Board) — Touch Dimmable

## SKU: AS-B-206-115-DLD — 206 Rechargeable 3 Color DOB (115mm)
Key features:
- 7W output (3.5W + 3.5W)
- LED on board + driver
- Touch dimming
- Plug-and-play  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample: ₹349
- 60+: ₹299
- 100+: ₹249
- 500+: ₹199
- 1000+: ₹149

## SKU: AS-B-206-75-DLD — 206 Rechargeable 3 Color DOB (75mm)
Key features:
- 4.8W output (2.4W + 2.4W)
- LED on board + driver
- Touch dimming
- Plug-and-play  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample: ₹299
- 60+: ₹249
- 100+: ₹219
- 500+: ₹179
- 1000+: ₹149

## SKU: SH-DOB-206-DLD-LC — 206 Rechargeable 3 Color DOB (55mm)
Key features:
- 2.4W output (1.2W + 1.2W)
- LED on board + driver
- Touch dimming
- Plug-and-play  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample (500+): ₹219
- 1000+: ₹149
- 5000+: ₹129
- (Higher tier price may be available — confirm with support.)

---

# 6) DC LED COB (Single LED COBs)

## SKU: SH-COB-0.5W — 0.5W LED COB (3V)
CCT: 3000K  
Spec:
- Input power: 3V, 0.5W
- 1 CREE LED, 11x11 mm  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample: ₹16
- 100+: ₹12

## SKU: SH-COB-2W-20 — 2W LED COB (20mm)
Spec:
- Input power: 3V @ 0.6A  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample: ₹60
- 100+: ₹45

## SKU: SH-COB-2W-35 (Catalog listing) — 2W LED COB (35mm)
Note: Catalog lists “2W LED COB (35mm)” without an explicit SKU in this KB.  
Spec:
- Input power: 3V @ 0.5A  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample: ₹75
- 100+: ₹56

## SKU: SH-COB-3W — 3W LED COB (3V)
CCT: 3000K  
Spec:
- Input power: 3V, 3W
- 6 CREE LEDs, 35mm dia  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample: ₹30
- 500+: ₹20

## SKU: SH-COB-5W — 5W LED COB (3V)
CCT: 3000K  
Spec:
- Input power: 3V, 5W
- 10 CREE LEDs, 35mm dia  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample: ₹40
- 500+: ₹25

## SKU: SH-COB-S-3W — 12V 3W LED COB
Spec:
- Input power: 12V, 3W
- 6 CREE LEDs, 35mm dia  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample: ₹65
- 100+: ₹48

## SKU: SH-COB-S-5W — 24V 5W LED COB
Spec:
- Input power: 24V, 5W
- 10 CREE LEDs, 35mm dia  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample: ₹80
- 100+: ₹45

---

# 7) Dual LED COB

## SKU: SH-COB-D-3W — 3W Dual LED COB
CCT: 2700K | 5700K  
Spec:
- 3V, 3W
- 6 CREE LEDs, 35mm dia  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample: ₹35
- 100+: ₹30

## SKU: SH-COB-D-5W — 5W Dual LED COB
CCT: 2700K | 5700K  
Spec:
- 3V, 5W
- 10 CREE LEDs, 35mm dia  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample: ₹60
- 100+: ₹49

## SKU: SH-COB-D-50MM (Catalog listing) — Dual LED COB (50mm)
CCT: 2700K | 5700K  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample: ₹80
- 100+: ₹60

---

# 8) COB LED Strip
Common specs:
- widths: 3mm, 5mm, 8mm, 10mm, 12mm
- voltage: 12V / 24V
- types: Warm White, CCT, RGB, RGBCW, RGBCCT
- densities: 120 LED/m, 320 LED/m, 400 LED/m
Certifications listed on strip page: UL, CE, UKCA, BIS, ROHS

## Strip examples (Canonical variant IDs)
Validity: price_valid_until=2026-06-30 (confirm after)

- SKU: SH-COB-ST-3-400 — 3mm COB Strip, 400 chip, 12V (WW): Sample ₹150 / 1m
- SKU: SH-COB-ST-5-400 — 5mm COB Strip, 400 chip, 12V (WW): Sample ₹150 / 1m
- SKU: SH-COB-ST-8-320-12 — 8mm COB Strip, 320 chip, 12V (WW): Sample ₹200 / 1m
- SKU: SH-COB-ST-8-320-24 — 8mm COB Strip, 320 chip, 24V (WW): Sample ₹210 / 1m
- SKU: SH-COB-ST-CCT-12 — 10mm COB Strip, CCT, 12V, 120 LED/m: Sample ₹150 / 1m
- SKU: SH-COB-ST-CCT-24 — 10mm COB Strip, CCT, 24V, 120 LED/m: Sample ₹200 / 1m
- SKU: SH-COB-ST-RGB-10 — RGB COB Strip, 10mm, 24V, 400 LED/m: Sample ₹365 / 1m
- SKU: SH-COB-ST-RGBCCT-12 — RGBCCT COB Strip, 12mm, 24V, 400 LED/m: Sample ₹700 / 1m
- SKU: SH-COB-ST-RGBCW-8 — RGBCW COB Strip, 8mm, 24V, 320 LED/m: Sample ₹680 / 1m

---

# 9) Decorative LEDs (5V)

## SKU: SH-LED-F-S — Flame LED (2 inch)
Input: 5V  
CCT: 1300K  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample (1–100m): ₹30/m
- 100m+: ₹10/m

## SKU: SH-LED-F-B — Flame LED (3 inch)
Input: 5V  
CCT: 1300K  

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- Sample (1–100m): ₹30/m
- 100m+: ₹10/m

## Fairy Lights
- SH-FL-WW — silver wire fairy light (10 LED/m; warm white/multicolour)
- SH-FL-MC — copper wire fairy light (10 LED/m; warm white/multicolour)

Pricing (INR)
Validity: price_valid_until=2026-06-30 (confirm after)
- silver wire fairy light: Sample ₹150, 50–1000+: ₹115
- copper wire fairy light: Sample ₹160, 100–1000+: ₹125

---

# 10) Flexible Filament LEDs
Validity: price_valid_until=2026-06-30 (confirm after)

- SH-FF-190 — Flexible Filament LED 190mm (3V), 2700K — ₹132
- SH-FF-300 — Flexible Filament LED 300mm (3V), 2700K — ₹148
- SH-FF-460 — Flexible Filament LED 460mm (12V), 2700K — ₹350
- SH-FF-600 — Flexible Filament LED 600mm (24V), 2700K — ₹600
- SH-FF-1200 — Flexible Filament LED 1200mm (24V), 2700K — ₹1200

---

# 11) Batteries (Li-ion 18650)
Validity: price_valid_until=2026-06-30 (confirm after)

- SH-BAT-12 — 18650 Li-ion 1200mAh — ₹50
- SH-BAT-26 — 18650 Li-ion 2600mAh (DMEGC) — ₹100
- SH-BAT-26-S — 18650 Li-ion 2600mAh (HLY, sleeve) — ₹125
- SH-BAT-52 — 18650*2 Li-ion 5200mAh (sleeve dual pack) — ₹240

Notes: UL/BIS referenced for batteries (component-level). Battery shipping restrictions vary by destination/courier.

---

# 12) Battery Holders
Validity: review_as_needed

- SH-AA-HLD — 3xAA battery holder (82mm dia), with ON/OFF switch
- SH-AAA-HLD — 3xAAA battery holder (72mm dia), with ON/OFF switch
- SH-18650-BAT-H — 18650 battery holder with cover, panel mount, brass terminals, ~6 inch wire

Price note: holder category shows ₹25 fixed for AA/AAA (confirm if needed for 18650 holder).

---

# 13) USB Cables
Validity: price_valid_until=2026-06-30 (confirm after)

- USB-A/C-01W (White) — Type A to C, 1.2m: Sample ₹50; 100+ ₹40
- USB-A/C-01W-B (Golden braided) — Type A to C, 1.2m: Sample ₹100; 100+ ₹90
- USB-C/C-01W-W — Type C to C, 1.2m, CE: Sample ₹120; 100+ ₹100
- USB-A/C-02W (Black) — A to C / C to C, 1.2m, UL: Sample ₹70; 100+ ₹65
- USB cable with switch — Type A, 1.2m: Sample ₹75; 100+ ₹70
- Type A to C, 1.2m, CE: Sample ₹70; 100+ ₹60

---

# 14) USB-C Panel Mount Connectors
Validity: price_valid_until=2026-06-30 (confirm after)

Common: CE certified, ~6 inch wire
- SH-USB-PMC-B — Black (without indicator): Sample ₹45; 100+ ₹40
- SH-USB-PMC-WI — Black (with indicator): Sample ₹70; 100+ ₹65
- SH-USB-PMC-W — White (without indicator): Sample ₹45; 100+ ₹40
- SH-USB-PMC-TP — Transparent (without indicator): Sample ₹65; 100+ ₹60
- SH-USB-PMC-DU — Dual USB: Sample ₹45; 100+ ₹40
- Push-fit variants also available (confirm exact SKU/price as needed).

---

# 15) Switches
Validity: price_valid_until=2026-06-30 (confirm after)

- SH-SWT-PBS — Push Button Switch — ₹25
- SH-SWT-RPB — Round Push Button Switch — ₹25
- SH-SWT-RS — Rocker Switch — ₹25
- SH-SWT-SPST — Round Rocker SPST Switch — ₹25

---

# 16) Add-ons & Accessories
Validity: review_as_needed

## Lens
- SH-COB-L-C — LED lens clear, PC material, 35mm dia
- SH-COB-L-F — LED lens frosted, PC material, 35mm dia
Compatible: 3W, 5W, 3W dual, 5W dual COBs

## Touch & wiring
- SH-TN-18-MM — Brass touch nut (M4 thread length options), used as touch button (subject to availability)
- SH-LUG-01 — Touch sensor (20cm wire) — ₹5
- SH-LUG-02 — Touch sensor gold finish — Sample ₹25; 1000+ ₹23
- SH-JST-WIRE — UL certified JST wire, custom length available
  Pricing note: up to 6 inches ₹8; per inch ₹1

## Enclosures
- SH-C-ENC-M — Plastic USB-C enclosure (panel mount for PCB, 19mm dia) — ₹10
  Compatible: AS-U-101-SLD, AS-U-102-DLD, AS-U-103-LSD
- SH-C-ENC — Metal enclosure (panel mount, 16mm dia) — ₹50
  Note: suitable for rechargeable drivers (confirm fitment per driver + lamp design)

## LED holders
- SH-COB-GLB-H — LED holder attachment for glass/stone, 10mm mounting hole, unfinished
- SH-COB-LED-H — LED holder with shade ring for E27 shades, 10mm mounting hole, unfinished
Price note: sample prices ~₹110–₹120 with quantity tier reductions (confirm per holder model).

---

# Product Pairings / Compatibility (Sales Assistant)
Validity: stable_logic

## Common Bundles (confirm wattage and use-case)
- Rechargeable single-color lamp bundle:
  AS-B-201-SLD + (2W/3W/5W COB) + 2600mAh battery + JST wire + touch nut + USB panel mount connector (optional)
- Rechargeable 3-color lamp bundle:
  AS-B-202-DLD + dual COB (2W+2W or 3W+3W) + 2600mAh battery + touch accessories
- Budget set (fast procurement):
  AS-B-201-SLD-LC or AS-B-202-DLD-LC
- USB powered lamp bundle:
  AS-U-101-SLD (or AS-U-102-DLD) + COB + USB cable + USB panel mount connector
- Strip lighting bundle:
  AS-B-204-LSD / AS-B-205-LSD OR AS-U-103-LSD + COB strip + wiring

---

# Integration Guides (Website / Commerce / ERP)
Validity: stable_guidance

## Hardware Control APIs
Smart Handicrafts modules are plug-and-play electronics. No public “device control API” is provided for drivers/modules.

## E-commerce compatibility (Product selling)
- Shopify: supported for listing/catalog + lead capture + documentation request flows
- WooCommerce: supported for listing/catalog
- Amazon: suitable for component sellers (ensure correct listing compliance + battery shipping rules)
- ERP/OMS/WMS: Odoo is compatible for product SKUs, price slabs, and CRM workflows

## Odoo usage guidance (business ops)
Suggested approach:
1) Create products by SKU (AS-B-201-SLD, AS-B-202-DLD, etc.)
2) Maintain price lists by quantity slab (sample / 60+ / 100+ / 500+ / 1000+)
3) Use CRM for lead capture:
   - application, wattage, power type, color, quantity, destination country
4) If you manage BOM bundles: create kits as “bundle products” or use BOM/Manufacturing if applicable.

## Zapier / Make (automation ideas)
- Website form → CRM lead in Odoo
- Certificate request form → email + CRM activity
- Quote request form → create opportunity + assign sales owner
- Post-sales support ticket → service inbox routing

---

# Policies and Company FAQs
Validity: policy_review_required_every=90_days (confirm before quoting)

## Shipping policy (general)
- Dispatch time depends on order quantity and stock availability.
- Samples generally ship faster than bulk.
- Export shipments depend on documentation and courier regulations (especially battery shipments).

## Returns policy (general)
- Returns are generally applicable for manufacturing defects or wrong item supplied.
- Custom or special assembly orders may be non-returnable (confirm case-by-case).

## Warranty / SLA (general)
- Technical queries: aim to respond within 1–2 business days.
- Production / dispatch SLA: depends on quantity and planning (confirm with support).

## Data / Privacy (general)
- Customer data used only for quotations, support, and documentation sharing.
- No resale of customer data (general commitment; confirm your formal policy if needed).

---

# Compliance & Export (Operational Guidance)
Validity: stable_guidance

## What the bot can say
- Component-level certifications and standards are referenced in the knowledge base.
- Final product compliance depends on final lamp design and testing.

## Certificate request workflow (recommended)
If user asks: “Send CE/UKCA/UL/RoHS documents”
Collect:
- Name, company, email, phone
- Product SKUs required
- Destination country
Then route to: care@smarthandicrafts.com

## HS codes
HS codes depend on product configuration and packaging. The bot must not declare a final HS code.
Recommend: confirm with customs broker / CHA.

## Country-specific restrictions
- Lithium-ion shipping rules vary by courier and destination.
- Some marketplaces require additional battery compliance.

## Export documents (typical)
- Commercial Invoice
- Packing List
- Certificate of Origin (if required)
- Requested component certificates (if applicable)

## Incoterms
- EXW (typical)
- FOB / CIF (only if agreed in quotation)

---

# Sales & Implementation Playbooks (B2B)
Validity: stable_logic

## Qualification questions (ask 3–5 max)
- Application: table lamp / wall lamp / DIY / hospitality / decorative / strip
- LED load (W): 0.5 / 2 / 3 / 5 / 7
- Power input: USB or rechargeable
- Color: 1-color or 3-color
- Quantity: sample / 60+ / 100+ / 500+ / 1000+
- Destination market: India or export (which country)
- Timeline: prototype / pilot / production

## Suggested package by customer type
- Artisan / DIY: LC series sets
- Exporter: driver + 2600mAh battery + accessories + doc-request flow
- OEM: bundle recommendations + technical review + consistent BOM/supply planning

## Common objections (safe)
- “China cheaper”: highlight reliability, support, compliance orientation, plug-and-play, consistent BOM supply.
- “Need custom module”: suggest contacting support for engineering review.
- “Need certificates”: route to document request workflow.

---

# Sales Automation Playbook (CRM-ready)
Validity: stable_logic

## Lead stages
1) Inquiry
2) Qualified
3) Technical Review
4) Quote Sent
5) Negotiation
6) Closed Won / Closed Lost

## Qualification rules
- Must capture at least: application + power type + color requirement + quantity bracket
- Export query → compliance assistant mode + document workflow

## ICP tiers (routing)
- Tier A: artisan / low volume
- Tier B: exporter / medium volume
- Tier C: OEM / high volume + repeat
- Tier D: hospitality project / bulk with timelines

## Required CRM fields for handoff
- Lead source (website / WhatsApp / referral / marketplace)
- Name, company, phone, email
- Country + city
- Application type
- LED wattage + color type
- Power type (USB/rechargeable)
- Quantity bracket
- Recommended SKU bundle
- Compliance/document request (yes/no)
- Next action (call / quote / sample dispatch / technical review)

## Proposal / quotation workflow (recommended)
1) Confirm requirements (wattage, power type, 1/3 color)
2) Recommend SKUs + bundle
3) Confirm quantity slab
4) Confirm destination + shipping method
5) Quote + timeline + doc requests

---

# Automation Intake Templates (STRICT FOR WORKFLOWS)
Purpose: improve “sales_automation” bot outputs.

## Template A — Quote Intake
Ask only missing fields:
- customer_name
- company_name
- email
- phone_or_whatsapp
- application (table lamp / wall / DIY / hospitality / decorative / strip)
- power_type (USB / rechargeable)
- led_type (COB / dual COB / strip / DOB)
- wattage
- color (1-color / 3-color)
- quantity_bracket (sample / 60+ / 100+ / 500+ / 1000+ / sets)
- destination_country (if export)
- timeline (prototype / pilot / production)

Output format (for automation mode):
```json
{
  "workflow": "quote_intake",
  "lead_stage": "Inquiry|Qualified|Technical Review",
  "recommended_skus": [],
  "bundle_suggestion": "",
  "missing_fields": [],
  "next_action": "request_details|send_quote|book_call",
  "support_contact": "care@smarthandicrafts.com"
}
