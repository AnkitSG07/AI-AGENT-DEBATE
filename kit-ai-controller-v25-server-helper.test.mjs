import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  sanitizeKitPlan,
  legacyActionsToKitPlan,
  buildKitControllerPromptContext,
  buildKitControllerPromptInstructions,
  deriveKitBuildGoal,
  reconcileKitPlanWithBuildGoal,
  resolveKitPlanForPayload
} from "./kit-ai-controller-v25-server-helper.js";

const kitContext = {
  controllerAvailable: true,
  kitBuilderSnapshot: {
    selectedApplication: "Rechargeable",
    selectedApplicationId: "rechargeable",
    selectedDriver: "AS-B-201-LC 201 LC Rechargeable 1 Color Driver",
    selectedDriverId: "201-lc",
    currentStep: "3",
    currentPartsTab: "led",
    selectedItemIds: ["201-lc-driver"],
    kit: {
      bodyMaterial: "",
      items: [{ id: "201-lc-driver", name: "201 LC driver", quantityPerKit: 1 }]
    },
    validation: {
      complete: false,
      progress: 35,
      errors: [{ id: "led", message: "Choose one compatible LED." }]
    },
    controller: {
      actions: [
        "select_application", "select_driver", "add_product", "remove_product",
        "set_body_material", "fill_required", "open_product_options", "go_to_step"
      ]
    },
    availableNow: {
      drivers: [
        { id: "201-lc", code: "AS-B-201-LC", name: "201 LC", family: "rechargeable", maxWatt: 3 }
      ],
      products: [
        { id: "2w-35mm", name: "2W 35mm COB", sku: "SH-COB-2W-35", category: "led", watt: 2, selected: false },
        { id: "battery-1200", name: "18650 Battery 1200mAh Without Sleeve", sku: "SH-BAT-1200", category: "battery", mah: 1200, selected: false }
      ]
    },
    planningCatalog: {
      applications: [
        { id: "rechargeable", name: "Rechargeable", allowedDrivers: ["201", "201-lc"], recommendedDriver: "201" }
      ],
      drivers: [
        {
          id: "201",
          code: "AS-B-201-SLD",
          name: "201 Rechargeable 1 Color Driver",
          family: "rechargeable",
          maxWatt: 5,
          touchRequired: true,
          supports: ["3w-single", "battery-2600-sleeve", "jst-2pin", "lug-wire"]
        },
        {
          id: "201-lc",
          code: "AS-B-201-LC",
          name: "201 LC Rechargeable 1 Color Driver",
          family: "rechargeable",
          maxWatt: 3,
          touchRequired: true,
          supports: ["2w-35mm", "3w-single", "battery-1200", "battery-2600-sleeve", "jst-2pin", "lug-wire"]
        }
      ],
      products: [
        {
          id: "2w-35mm",
          name: "2W 35mm Single COB LED",
          sku: "SH-COB-2W-35",
          category: "led",
          watt: 2,
          mah: 0,
          optionsRequired: false
        },
        {
          id: "3w-single",
          name: "3W Single COB LED",
          sku: "SH-COB-3",
          category: "led",
          watt: 3,
          mah: 0,
          optionsRequired: false
        },
        {
          id: "battery-1200",
          name: "18650 Battery 1200mAh Without Sleeve",
          sku: "SH-BAT-1200",
          category: "battery",
          watt: 0,
          mah: 1200,
          needsHolder: true,
          optionsRequired: false
        },
        {
          id: "battery-2600-sleeve",
          name: "18650 Battery 2600mAh With Sleeve",
          sku: "SH-BAT-26S",
          category: "battery",
          watt: 0,
          mah: 2600,
          optionsRequired: false
        },
        {
          id: "jst-2pin",
          name: "JST Wire - Dual Side (Custom Length)",
          sku: "LEDWIRE",
          category: "wire",
          optionsRequired: true
        },
        {
          id: "lug-wire",
          name: "Lug Wire",
          sku: "",
          category: "wire",
          optionsRequired: true
        }
      ],
      templates: [
        { id: "tpl-201-lc-2w", name: "201 LC 2W Kit", appId: "rechargeable", driverId: "201-lc" }
      ]
    }
  }
};

// Basic exact-ID sanitizer remains strict.
const plan = sanitizeKitPlan({
  mode: "auto_build",
  actions: [
    { type: "select_application", applicationId: "rechargeable" },
    { type: "select_driver", builder_driver_id: "201-lc" },
    { type: "add_product", builder_product_id: "2w-35mm", qty: 1 },
    { type: "go_to_step", step: 4 }
  ]
}, kitContext);
assert.equal(plan.actions[1].driverId, "201-lc");
assert.equal(plan.actions[2].productId, "2w-35mm");

assert.throws(
  () => sanitizeKitPlan({ actions: [{ type: "add_product", productId: "invented-sku" }] }, kitContext),
  /Unknown product id/
);
assert.throws(
  () => sanitizeKitPlan({ actions: [{ type: "select_driver", driverId: "999" }] }, kitContext),
  /Unknown driver id/
);

// Full catalogue must be present in prompt context even when builder is initially empty.
const promptContext = buildKitControllerPromptContext(kitContext);
assert.equal(promptContext.selected_driver_id, "201-lc");
assert.ok(promptContext.catalog_products.some((p) => p.id === "battery-1200"));
assert.ok(promptContext.catalog_drivers.some((d) => d.id === "201-lc"));
assert.equal(promptContext.catalog_products.find((p) => p.id === "jst-2pin").optionsRequired, true);

// Explicit current-turn requirements become a locked exact build goal.
const explicitQuestion =
  "Build it for me now. Make a small rechargeable table lamp using the 201 LC driver, " +
  "a 2W 35mm LED, a 1200mAh battery, and a metal lamp body. " +
  "If JST or Lug Wire length needs my choice, stop and ask me instead of guessing.";

const projectState = {
  power_type: "rechargeable",
  product_type: "table_lamp",
  desired_led_wattage_w: 2,
  battery_capacity_mah: 1200,
  body_material: "metal"
};

const goal = deriveKitBuildGoal({
  question: explicitQuestion,
  projectState,
  kitContext
});

assert.equal(goal.locked, true);
assert.equal(goal.applicationId, "rechargeable");
assert.equal(goal.driverId, "201-lc");
assert.equal(goal.ledProductId, "2w-35mm");
assert.equal(goal.desiredLedWattageW, 2);
assert.equal(goal.batteryProductId, "battery-1200");
assert.equal(goal.batteryMah, 1200);
assert.equal(goal.bodyMaterial, "metal");
assert.equal(goal.coreResolved, true);

// Regression: a bad model plan may ask for 3W and omit the requested battery.
// Reconciliation must repair it to the immutable 2W / 1200mAh goal.
const wrongModelPlan = sanitizeKitPlan({
  mode: "auto_build",
  summary: "Bad draft",
  requires_user_input: true,
  user_input_reason: "battery unknown",
  actions: [
    { type: "select_application", applicationId: "rechargeable" },
    { type: "select_driver", driverId: "201-lc" },
    { type: "add_product", productId: "3w-single", quantity: 1 },
    { type: "add_product", productId: "jst-2pin", quantity: 1 },
    { type: "set_body_material", value: "metal" }
  ]
}, kitContext);

const repaired = reconcileKitPlanWithBuildGoal(wrongModelPlan, goal, kitContext);
const repairedAdds = repaired.actions.filter((a) => a.type === "add_product").map((a) => a.productId);
assert.ok(repairedAdds.includes("2w-35mm"), "2W goal LED must be added");
assert.ok(repairedAdds.includes("battery-1200"), "1200mAh goal battery must be added");
assert.ok(!repairedAdds.includes("3w-single"), "3W contradiction must be removed");
assert.ok(repaired.actions.some((a) => a.type === "fill_required"), "auto-build must delegate deterministic dependencies to fill_required");

// Regression: continuation drift must not overwrite the preserved original build goal.
const driftedContinuationGoal = deriveKitBuildGoal({
  question:
    "Continue building the active kit from the current verified Kit Builder state. " +
    "This is automatic build continuation turn 1.",
  projectState: {
    power_type: "rechargeable",
    desired_led_wattage_w: 3,
    battery_capacity_mah: 1200,
    body_material: "metal"
  },
  kitContext,
  incomingBuildGoal: goal
});
assert.equal(driftedContinuationGoal.driverId, "201-lc");
assert.equal(driftedContinuationGoal.desiredLedWattageW, 2);
assert.equal(driftedContinuationGoal.ledProductId, "2w-35mm");
assert.equal(driftedContinuationGoal.batteryProductId, "battery-1200");

// In V25 controller mode, legacy active_kit_actions are not silently upgraded when no native plan exists.
const controllerOnlyNoPlan = resolveKitPlanForPayload({
  parsedResponse: {},
  activeKitActions: [
    { action: "add", builder_product_id: "lug-wire", qty: 1 }
  ],
  kitContext,
  buildGoal: goal,
  controllerMode: true,
  allowLegacyFallback: false
});
assert.equal(controllerOnlyNoPlan, null);

// Legacy compatibility still works explicitly outside controller-only mode.
const legacy = legacyActionsToKitPlan([
  { action: "add", builder_driver_id: "201-lc", qty: 1 },
  { action: "add", builder_product_id: "2w-35mm", qty: 1 }
], kitContext);
assert.deepEqual(legacy.actions.map((a) => a.type), ["select_driver", "add_product"]);

// Native controller plan gets goal reconciliation through resolveKitPlanForPayload.
const resolved = resolveKitPlanForPayload({
  parsedResponse: { kit_plan: wrongModelPlan },
  activeKitActions: [{ action: "add", builder_product_id: "lug-wire", qty: 1 }],
  kitContext,
  buildGoal: goal,
  controllerMode: true,
  allowLegacyFallback: false
});
assert.ok(resolved.actions.some((a) => a.type === "add_product" && a.productId === "2w-35mm"));
assert.ok(!resolved.actions.some((a) => a.type === "add_product" && a.productId === "3w-single"));

// Prompt contract must explicitly prohibit legacy mutation and conditional-example selection.
const instructions = buildKitControllerPromptInstructions(kitContext, goal);
assert.match(instructions, /kit_plan is the ONLY mutation contract/i);
assert.match(instructions, /2W goal must never become 3W/i);
assert.match(instructions, /conditional example/i);

// Server source regression: conditional/negative product mentions must be excluded from exact-selection parsing,
// and controller mode must gate legacy mutation paths.
const serverSource = await readFile(new URL("./server.js", import.meta.url), "utf8");
assert.match(serverSource, /stop\\s\+and\\s\+ask/);
assert.match(serverSource, /controllerMutationMode/);
assert.match(serverSource, /controller_mode_active/);

console.log("Kit AI Controller V25.1 regression tests passed.");
