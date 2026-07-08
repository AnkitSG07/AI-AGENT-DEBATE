#!/usr/bin/env node
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fakeShopPath = resolve(__dirname, "fake_shop.html");
const fakeShopUrl = `file://${fakeShopPath.replace(/\\/g, "/")}`;

// Safety guard: this demo is intentionally locked to the local fake HTML file.
// Do not change this to a real shop URL.
if (!fakeShopUrl.startsWith("file://") || !fakeShopUrl.endsWith("fake_shop.html")) {
  throw new Error("Safety guard failed: fake_cod_bot.mjs can only run on fake_shop.html.");
}

const customer = {
  size: "UK 9",
  name: "Demo Customer",
  phone: "9999999999",
  address: "Demo Address, Local Test Page Only",
  pincode: "110017",
  payment: "Cash on Delivery"
};

const browser = await chromium.launch({ headless: false, slowMo: 250 });
const page = await browser.newPage();

await page.goto(fakeShopUrl);

const title = await page.title();
if (title !== "Fake COD Sneaker Shop Demo") {
  await browser.close();
  throw new Error("Safety guard failed: this is not the fake local demo page.");
}

await page.selectOption("#size", { label: customer.size });
await page.click("#addToCart");
await page.fill("#name", customer.name);
await page.fill("#phone", customer.phone);
await page.fill("#address", customer.address);
await page.fill("#pincode", customer.pincode);
await page.selectOption("#payment", { label: customer.payment });
await page.click("#placeOrder");

const status = await page.textContent("#status");
console.log(status || "Fake demo finished.");

await page.waitForTimeout(5000);
await browser.close();
