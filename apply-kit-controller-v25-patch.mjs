#!/usr/bin/env node
/*
  Applies the Smart Handicrafts Kit Controller V25 integration to the CURRENT server.js.
  It is intentionally anchor-based and fail-closed: if the expected current code is not found,
  it refuses to write a partial patch.

  Usage from repository root:
    node apply-kit-controller-v25-patch.mjs ./server.js

  Place kit-ai-controller-v25-server-helper.js beside server.js first.
*/
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve, dirname, basename, join } from "node:path";

const target = resolve(process.argv[2] || "./server.js");
let source = await readFile(target, "utf8");
const original = source;
const changes = [];

function replaceOnce(label, before, after) {
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly 1 anchor, found ${count}. No file was written.`);
  }
  source = source.replace(before, after);
  changes.push(label);
}

if (source.includes('from "./kit-ai-controller-v25-server-helper.js"')) {
  console.log("Kit Controller V25 import already present; refusing to patch twice.");
  process.exit(0);
}

replaceOnce(
  "helper import",
  'import { randomUUID } from "node:crypto";\n',
  'import { randomUUID } from "node:crypto";\nimport { buildKitControllerPromptInstructions, resolveKitPlanForPayload, summarizeKitPlan } from "./kit-ai-controller-v25-server-helper.js";\n'
);

replaceOnce(
  "prompt variable start",
  '    const prompt = `\nYou are Smart Handicrafts® Kit Expert.\n',
  '    const basePrompt = `\nYou are Smart Handicrafts® Kit Expert.\n'
);

replaceOnce(
  "prompt controller append",
  'Answer using only LIVE ODOO WEBSITE PRODUCTS.\n`;\n\n    const kitAiGeminiContents = buildKitAiGeminiContents(prompt, normalizedLampReferenceImage);',
  'Answer using only LIVE ODOO WEBSITE PRODUCTS.\n`;\n    const prompt = basePrompt + buildKitControllerPromptInstructions(kitContext || {});\n\n    const kitAiGeminiContents = buildKitAiGeminiContents(prompt, normalizedLampReferenceImage);'
);

replaceOnce(
  "return schema kit_plan",
  '  ],\n  "action_offer": "active_kit | cart | none"\n}\nRules for recommended_products:',
  '  ],\n  "kit_plan": {\n    "mode": "guide | apply | auto_build",\n    "summary": "short purpose",\n    "requires_user_input": false,\n    "user_input_reason": "",\n    "actions": []\n  },\n  "action_offer": "active_kit | cart | none"\n}\nRules for recommended_products:'
);

replaceOnce(
  "direct controller plan",
  '    if (directControllerResponse) {\n      const directPayload = {',
  '    if (directControllerResponse) {\n      const directKitPlan = resolveKitPlanForPayload({\n        parsedResponse: {},\n        activeKitActions: directControllerResponse.active_kit_actions || [],\n        kitContext: kitContext || {}\n      });\n      const directPayload = {'
);

replaceOnce(
  "direct payload kit_plan",
  '        active_kit_actions: directControllerResponse.active_kit_actions || [],\n        alternative_products: [],',
  '        active_kit_actions: directControllerResponse.active_kit_actions || [],\n        kit_plan: directKitPlan,\n        kit_plan_summary: summarizeKitPlan(directKitPlan),\n        alternative_products: [],'
);

replaceOnce(
  "final plan computation",
  '    const finalPayload = {\n      ok: true,',
  '    const kitPlan = resolveKitPlanForPayload({\n      parsedResponse,\n      activeKitActions,\n      kitContext: kitContext || {}\n    });\n    const finalPayload = {\n      ok: true,'
);

replaceOnce(
  "final payload kit_plan",
  '      active_kit_actions: activeKitActions,\n      alternative_products: alternativeProducts,',
  '      active_kit_actions: activeKitActions,\n      kit_plan: kitPlan,\n      kit_plan_summary: summarizeKitPlan(kitPlan),\n      alternative_products: alternativeProducts,'
);

// Fail-closed post checks before writing.
for (const needle of [
  'buildKitControllerPromptInstructions(kitContext || {})',
  'kit_plan: directKitPlan',
  'kit_plan: kitPlan',
  'resolveKitPlanForPayload({',
  'const basePrompt = `'
]) {
  if (!source.includes(needle)) throw new Error(`Post-check failed for ${needle}. No file was written.`);
}

const backup = join(dirname(target), `${basename(target)}.before-kit-controller-v25.bak`);
await copyFile(target, backup);
await writeFile(target, source, "utf8");

console.log(`Patched: ${target}`);
console.log(`Backup:  ${backup}`);
console.log(`Changes: ${changes.join(", ")}`);
console.log("Next: run `node --check server.js` and your normal test suite before deployment.");
