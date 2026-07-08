# Safe Comet Drop Helper

This folder contains two safe learning tools:

1. **Timed drop helper** for the real drop.
   - Opens the product page 3 minutes before sale.
   - Beeps 10 seconds before sale.
   - Opens the product page again at sale time.
   - It does **not** click Add to Cart, bypass queues/CAPTCHA, select COD, or place orders.

2. **Fake local COD checkout demo** for learning browser automation.
   - Runs only against `fake_shop.html` on your own computer.
   - Demonstrates size selection, fake cart, fake address fill, COD selection, and fake order placement.
   - It is intentionally guarded so it does not run against a real store.

## Render/public page

Because the main app serves the `public` folder, the helper page is available at:

```text
/comet-drop-helper.html
```

Use it like this:

1. Open the page in your browser.
2. Confirm the product URL.
3. Confirm sale time as `2026-07-09 18:00` India time.
4. Press **Start helper**.
5. Manually complete checkout when the page opens.

## CLI timed helper

From this folder:

```bash
node timed-drop-helper.mjs
```

Custom URL/time example:

```bash
node timed-drop-helper.mjs --url=https://www.wearcomet.com/products/extra-toppings-only --sale-time=2026-07-09T18:00:00+05:30
```

## Fake COD automation demo

Install Playwright inside this folder:

```bash
npm install
npx playwright install chromium
```

Run the fake local demo:

```bash
node fake_cod_bot.mjs
```

This opens `fake_shop.html`, selects `UK 9`, fills fake customer data, chooses **Cash on Delivery**, and places a fake local order.

## Important boundary

Do not modify the fake demo to target Comet or any real limited-drop shop. For the real drop, use the manual helper only:

```text
Open page -> beep -> sale time -> manually size -> Add to Cart -> COD -> Place Order
```
