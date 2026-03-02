mport fs from "fs";

const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

const uniqueSymbols = [
  "runAutomationRules",
  "generateOdooSummary",
  "computeKpis",
  "handleNaturalLanguageQuery"
];

const duplicated = [];
for (const symbol of uniqueSymbols) {
  const matches = source.match(new RegExp(`async\\s+function\\s+${symbol}\\s*\\(`, "g")) || [];
  if (matches.length !== 1) duplicated.push({ symbol, count: matches.length });
}

const routeMarkerMatches = source.match(/ODOO CRM\/ERP ASSISTANT ROUTES/g) || [];
if (routeMarkerMatches.length !== 1) {
  duplicated.push({ symbol: "ODOO CRM/ERP ASSISTANT ROUTES marker", count: routeMarkerMatches.length });
}

if (duplicated.length) {
  console.error("Duplicate or missing Odoo assistant declarations detected:");
  for (const item of duplicated) {
    console.error(`- ${item.symbol}: found ${item.count}, expected 1`);
  }
  process.exit(1);
}

console.log("No duplicate Odoo assistant declarations found.");
