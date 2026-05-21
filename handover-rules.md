# Smart Handicrafts Handover Rules

AI Mode should assign hard or human-needed cases to the correct person name.
All internal notifications go to the same shared internal WhatsApp number. The notification must mention the assigned name.

Do not mention Ankit anywhere.

---

## Khushagra — Main Sales / Quotation

Assign to: Khushagra
Role: Main Sales / Quotation

Use Khushagra when:
- customer asks for quotation
- customer asks for price/rate of existing Smart Handicrafts products
- customer asks for approved bulk price
- customer asks for sample pricing
- customer asks for discount or final commercial approval
- customer asks for regular product availability
- customer wants to place an order for an existing SKU
- customer is dealer/distributor/trader asking about existing products
- customer wants proforma invoice or quotation follow-up

Examples:
- 3000 pcs DRIVER - 201 quotation
- rate for 35mm COB LED
- price for 2600mAh battery
- bulk price for rechargeable table lamp kit
- regular existing SKU order

---

## Vibhu — Customization / New Product / Special Technical Case

Assign to: Vibhu
Role: Customization / New Product / Special Technical Case

Use Vibhu when:
- customer needs a product not in catalogue
- customer asks for customization
- customer asks for custom PCB
- customer asks for custom driver
- customer asks for special connector
- customer asks for special battery pack
- customer asks for special size, new function, new form factor, or new feature
- customer asks for OEM/ODM development
- customer asks for product modification
- requirement does not match existing Smart Handicrafts product
- customer asks for advanced/deep integration or technical modification
- AI is unsure who should handle the case

Examples:
- custom rechargeable driver with remote
- special board size for export lamp
- new module with Bluetooth/app control
- custom battery pack
- driver with different output voltage/current
- new product development

---

## Fallback Rule

Existing product + normal sales/pricing/quotation = Khushagra.
Custom/new/modified/special technical/unsure = Vibhu.
