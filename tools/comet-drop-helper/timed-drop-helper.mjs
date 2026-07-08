#!/usr/bin/env node
import { execFile } from "node:child_process";
import { platform } from "node:os";
import readline from "node:readline";

const DEFAULT_URL = "https://www.wearcomet.com/products/extra-toppings-only";
const DEFAULT_SALE_TIME = "2026-07-09T18:00:00+05:30";

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : fallback;
}

function validateHttpsUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Only https product URLs are allowed.");
  }
  return parsed.toString();
}

function openUrl(url) {
  const os = platform();
  const command = os === "win32" ? "cmd" : os === "darwin" ? "open" : "xdg-open";
  const args = os === "win32" ? ["/c", "start", "", url] : [url];
  execFile(command, args, { windowsHide: true }, (error) => {
    if (error) {
      console.log(`Could not open browser automatically. Open manually: ${url}`);
    }
  });
}

function beep(times = 3) {
  for (let i = 0; i < times; i += 1) {
    process.stdout.write("\u0007");
  }
}

function formatRemaining(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

const productUrl = validateHttpsUrl(argValue("url", DEFAULT_URL));
const saleTimeRaw = argValue("sale-time", DEFAULT_SALE_TIME);
const saleAt = new Date(saleTimeRaw);

if (Number.isNaN(saleAt.getTime())) {
  throw new Error(`Invalid sale time: ${saleTimeRaw}. Use ISO format like 2026-07-09T18:00:00+05:30`);
}

console.log("Safe timed drop helper started.");
console.log("Product:", productUrl);
console.log("Sale time:", saleAt.toString());
console.log("\nThis helper only opens the page and alerts you.");
console.log("Manual flow: size -> Add to Cart -> checkout -> Cash on Delivery -> Place Order.\n");

let openedEarly = false;
let warned10 = false;
let openedAtDrop = false;

const timer = setInterval(() => {
  const remaining = saleAt.getTime() - Date.now();
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(`Time left: ${formatRemaining(remaining)} `);

  if (remaining <= 180000 && remaining > 10000 && !openedEarly) {
    openedEarly = true;
    console.log("\nOpening product page 3 minutes before sale...");
    beep(2);
    openUrl(productUrl);
  }

  if (remaining <= 10000 && remaining > 0 && !warned10) {
    warned10 = true;
    console.log("\n10 seconds left. Keep mouse ready.");
    beep(6);
  }

  if (remaining <= 0 && !openedAtDrop) {
    openedAtDrop = true;
    console.log("\nSale time reached. Opening product page again.");
    beep(10);
    openUrl(productUrl);
    console.log("Now manually select size, Add to Cart, COD, and Place Order.");
    clearInterval(timer);
  }
}, 250);
