/*
  Smart Handicrafts Kit AI Controller V25 - server helper
  -------------------------------------------------------
  Purpose:
  - Keep model-generated Kit Builder plans on a strict, exact-ID contract.
  - Preserve the current legacy active_kit_actions path while adding a richer kit_plan.
  - Never validate compatibility on the server by guessing. The browser Kit Builder remains
    the final deterministic authority and previews/executes every plan through its own engine.

  This file is dependency-free ESM and can be imported by server.js.
*/

export const KIT_CONTROLLER_SCHEMA_VERSION = 1;

export const KIT_CONTROLLER_ACTION_TYPES = Object.freeze([
  "select_application",
  "select_driver",
  "select_direct_power",
  "add_product",
  "remove_product",
  "set_product_quantity",
  "set_kit_quantity",
  "set_name",
  "set_body_material",
  "set_adapter",
  "set_strip_load",
  "fill_required",
  "remove_optional",
  "load_template",
  "new_kit",
  "go_to_step",
  "go_to_category",
  "open_product_options",
  "check_live_price",
  "save_kit"
]);

const ACTION_SET = new Set(KIT_CONTROLLER_ACTION_TYPES);
const CATEGORY_SET = new Set(["led", "battery", "wiring", "addons"]);
const BODY_MATERIAL_SET = new Set(["metal", "nonconductive"]);
const ADAPTER_VOLTAGES = new Set([5, 12, 24]);

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value, max = 240) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function integer(value, min, max) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

function finiteNumber(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function snapshotFrom(kitContext = {}) {
  return isPlainObject(kitContext?.kitBuilderSnapshot) ? kitContext.kitBuilderSnapshot : {};
}

function planningCatalogFrom(kitContext = {}) {
  const snapshot = snapshotFrom(kitContext);
  return isPlainObject(snapshot.planningCatalog) ? snapshot.planningCatalog : {};
}

function idsFrom(list) {
  return new Set((Array.isArray(list) ? list : []).map((item) => text(item?.id || item, 100)).filter(Boolean));
}

function mapsFromCatalog(catalog = {}) {
  return {
    applications: idsFrom(catalog.applications),
    drivers: idsFrom(catalog.drivers),
    products: idsFrom(catalog.products),
    templates: idsFrom(catalog.templates)
  };
}

function normalizeActionType(rawType = "") {
  const key = text(rawType, 80).toLowerCase().replace(/[\s-]+/g, "_");
  const aliases = {
    application: "select_application",
    choose_application: "select_application",
    set_application: "select_application",
    driver: "select_driver",
    choose_driver: "select_driver",
    set_driver: "select_driver",
    direct_power: "select_direct_power",
    add: "add_product",
    add_item: "add_product",
    remove: "remove_product",
    delete_product: "remove_product",
    delete_item: "remove_product",
    set_quantity: "set_product_quantity",
    product_quantity: "set_product_quantity",
    kit_quantity: "set_kit_quantity",
    body_material: "set_body_material",
    adapter: "set_adapter",
    strip_load: "set_strip_load",
    fill: "fill_required",
    fill_required_parts: "fill_required",
    clear_optional: "remove_optional",
    template: "load_template",
    reset: "new_kit",
    step: "go_to_step",
    category: "go_to_category",
    options: "open_product_options",
    live_price: "check_live_price",
    checkout_review: "check_live_price",
    save: "save_kit"
  };
  return aliases[key] || key;
}

function exactId(raw, fields = []) {
  for (const field of fields) {
    const value = text(raw?.[field], 100);
    if (value) return value;
  }
  return "";
}

function assertKnown(id, set, label) {
  if (!id || !set.has(id)) throw new Error(`Unknown ${label} id: ${id || "(missing)"}`);
  return id;
}

/**
 * A compact prompt-safe controller context. Use this in addition to compactKitAiContext().
 * It deliberately sends exact canonical IDs and only the active/available subset first.
 */
export function buildKitControllerPromptContext(kitContext = {}) {
  const snapshot = snapshotFrom(kitContext);
  const catalog = planningCatalogFrom(kitContext);
  const contract = isPlainObject(snapshot.controller) ? snapshot.controller : {};
  const available = isPlainObject(snapshot.availableNow) ? snapshot.availableNow : {};
  const validation = isPlainObject(snapshot.validation) ? snapshot.validation : {};

  const compactProduct = (p = {}) => ({
    id: text(p.id, 100),
    name: text(p.name, 180),
    sku: text(p.sku, 120),
    category: text(p.category || p.bucket, 80),
    watt: Number.isFinite(Number(p.watt)) ? Number(p.watt) : 0,
    mah: Number.isFinite(Number(p.mah)) ? Number(p.mah) : 0,
    voltage: Number.isFinite(Number(p.voltage)) ? Number(p.voltage) : null,
    optionsRequired: !!p.optionsRequired,
    selected: !!p.selected,
    quantity: Number.isFinite(Number(p.quantity)) ? Number(p.quantity) : 0,
    reason: text(p.reason, 180)
  });

  const compactDriver = (d = {}) => ({
    id: text(d.id, 100),
    code: text(d.code, 120),
    name: text(d.name, 180),
    family: text(d.family, 80),
    maxWatt: Number.isFinite(Number(d.maxWatt)) ? Number(d.maxWatt) : null
  });

  const compactApplication = (a = {}) => ({
    id: text(a.id, 100),
    name: text(a.name, 180),
    recommendedDriver: text(a.recommendedDriver, 100),
    allowedDrivers: Array.isArray(a.allowedDrivers) ? a.allowedDrivers.map((x) => text(x, 100)).filter(Boolean).slice(0, 20) : [],
    allowDirect: !!a.allowDirect
  });

  return {
    schema: KIT_CONTROLLER_SCHEMA_VERSION,
    bridge_available: !!snapshot.controller,
    selected_application_id: text(snapshot.selectedApplicationId || snapshot.application?.id, 100),
    selected_driver_id: text(snapshot.selectedDriverId || snapshot.driver?.id, 100),
    current_step: text(snapshot.currentStep || snapshot.ui?.step, 20),
    current_category: text(snapshot.currentPartsTab || snapshot.ui?.category, 40),
    selected_product_ids: Array.isArray(snapshot.selectedItemIds)
      ? snapshot.selectedItemIds.map((x) => text(x, 100)).filter(Boolean).slice(0, 100)
      : Array.isArray(snapshot.kit?.items)
        ? snapshot.kit.items.map((x) => text(x?.id, 100)).filter(Boolean).slice(0, 100)
        : [],
    validation: {
      complete: !!validation.complete,
      progress: Number.isFinite(Number(validation.progress)) ? Number(validation.progress) : null,
      errors: Array.isArray(validation.errors)
        ? validation.errors.slice(0, 20).map((e) => ({ id: text(e?.id, 100), message: text(e?.message, 280) }))
        : []
    },
    available_now: {
      drivers: (Array.isArray(available.drivers) ? available.drivers : []).slice(0, 24).map(compactDriver),
      products: (Array.isArray(available.products) ? available.products : []).slice(0, 140).map(compactProduct)
    },
    applications: (Array.isArray(catalog.applications) ? catalog.applications : []).slice(0, 24).map(compactApplication),
    templates: (Array.isArray(catalog.templates) ? catalog.templates : []).slice(0, 40).map((t) => ({
      id: text(t?.id, 100), name: text(t?.name, 180), appId: text(t?.appId, 100), driverId: text(t?.driverId, 100)
    })),
    supported_actions: Array.isArray(contract.actions) && contract.actions.length
      ? contract.actions.filter((x) => ACTION_SET.has(text(x, 80))).slice(0, 30)
      : KIT_CONTROLLER_ACTION_TYPES,
    safety: [
      "Use exact Kit Builder IDs only; never invent an id, SKU, option value, or compatibility fact.",
      "Do not bypass ambiguity. Ask the user before choosing an unresolved LED wattage, battery variant/capacity, body material, custom length, or other required option.",
      "The browser Kit Builder previews and validates every action and remains the final authority.",
      "Do not automatically confirm the final cart mutation. check_live_price only opens/verifies the review path."
    ]
  };
}

/**
 * Strictly validate a model-provided kit_plan against exact IDs from the browser planning catalog.
 * Invalid/unknown actions throw; callers should omit the plan rather than guess.
 */
export function sanitizeKitPlan(rawPlan = {}, kitContext = {}, { maxActions = 40 } = {}) {
  if (!isPlainObject(rawPlan)) return { version: KIT_CONTROLLER_SCHEMA_VERSION, mode: "guide", summary: "", actions: [] };
  const catalog = planningCatalogFrom(kitContext);
  const ids = mapsFromCatalog(catalog);
  const rawActions = Array.isArray(rawPlan.actions) ? rawPlan.actions : [];
  if (rawActions.length > maxActions) throw new Error(`kit_plan exceeds ${maxActions} actions.`);

  const actions = rawActions.map((raw, index) => {
    if (!isPlainObject(raw)) throw new Error(`kit_plan action ${index + 1} is not an object.`);
    const type = normalizeActionType(raw.type || raw.action);
    if (!ACTION_SET.has(type)) throw new Error(`Unsupported kit_plan action: ${type || "(missing)"}`);
    const out = { type };

    switch (type) {
      case "select_application": {
        const id = exactId(raw, ["applicationId", "application_id", "id", "value"]);
        out.applicationId = assertKnown(id, ids.applications, "application");
        break;
      }
      case "select_driver": {
        const id = exactId(raw, ["driverId", "driver_id", "builder_driver_id", "builderDriverId", "id", "value"]);
        out.driverId = assertKnown(id, ids.drivers, "driver");
        const appId = exactId(raw, ["applicationId", "application_id"]);
        if (appId) out.applicationId = assertKnown(appId, ids.applications, "application");
        break;
      }
      case "select_direct_power":
      case "fill_required":
      case "remove_optional":
      case "new_kit":
      case "check_live_price":
      case "save_kit":
        break;
      case "add_product":
      case "remove_product":
      case "open_product_options": {
        const id = exactId(raw, ["productId", "product_id", "builder_product_id", "builderProductId", "id", "value"]);
        out.productId = assertKnown(id, ids.products, "product");
        if (type === "add_product") out.quantity = integer(raw.quantity ?? raw.qty ?? 1, 1, 1000) || 1;
        break;
      }
      case "set_product_quantity": {
        const id = exactId(raw, ["productId", "product_id", "builder_product_id", "builderProductId", "id", "value"]);
        out.productId = assertKnown(id, ids.products, "product");
        const quantity = integer(raw.quantity ?? raw.qty, 1, 1000);
        if (!quantity) throw new Error(`Invalid quantity for ${id}.`);
        out.quantity = quantity;
        break;
      }
      case "set_kit_quantity": {
        const quantity = integer(raw.quantity ?? raw.qty ?? raw.value, 1, 10000);
        if (!quantity) throw new Error("Invalid kit quantity.");
        out.quantity = quantity;
        break;
      }
      case "set_name": {
        const value = text(raw.value ?? raw.name, 80);
        if (!value) throw new Error("Kit name is empty.");
        out.value = value;
        break;
      }
      case "set_body_material": {
        const value = text(raw.value ?? raw.bodyMaterial ?? raw.body_material, 40).toLowerCase();
        if (!BODY_MATERIAL_SET.has(value)) throw new Error(`Unsupported body material: ${value || "(missing)"}`);
        out.value = value;
        break;
      }
      case "set_adapter": {
        const voltageRaw = raw.voltage ?? raw.adapter?.voltage;
        const currentRaw = raw.currentA ?? raw.current_a ?? raw.adapter?.currentA;
        const suppliedRaw = raw.suppliedSeparately ?? raw.supplied_separately ?? raw.adapter?.suppliedSeparately;
        if (voltageRaw !== undefined && voltageRaw !== null && voltageRaw !== "") {
          const voltage = Number(voltageRaw);
          if (!ADAPTER_VOLTAGES.has(voltage)) throw new Error("Adapter voltage must be 5, 12, or 24V.");
          out.voltage = voltage;
        }
        if (currentRaw !== undefined && currentRaw !== null && currentRaw !== "") {
          const currentA = finiteNumber(currentRaw, 0.01, 100);
          if (currentA == null) throw new Error("Adapter current must be between 0.01A and 100A.");
          out.currentA = currentA;
        }
        if (suppliedRaw !== undefined) out.suppliedSeparately = suppliedRaw === true;
        break;
      }
      case "set_strip_load": {
        const value = finiteNumber(raw.value ?? raw.watt ?? raw.watts ?? raw.loadW, 0.01, 10000);
        if (value == null) throw new Error("Invalid strip load.");
        out.value = value;
        break;
      }
      case "load_template": {
        const id = exactId(raw, ["templateId", "template_id", "id", "value"]);
        out.templateId = assertKnown(id, ids.templates, "template");
        break;
      }
      case "go_to_step": {
        const step = integer(raw.step ?? raw.value, 1, 4);
        if (!step) throw new Error("Kit Builder step must be 1-4.");
        out.step = step;
        break;
      }
      case "go_to_category": {
        const category = text(raw.category ?? raw.value ?? raw.id, 40).toLowerCase();
        if (!CATEGORY_SET.has(category)) throw new Error(`Unknown Kit Builder category: ${category || "(missing)"}`);
        out.category = category;
        break;
      }
      default:
        throw new Error(`Unhandled kit_plan action: ${type}`);
    }

    return out;
  });

  const modeRaw = text(rawPlan.mode, 40).toLowerCase();
  const mode = ["guide", "apply", "auto_build"].includes(modeRaw) ? modeRaw : "guide";
  return {
    version: KIT_CONTROLLER_SCHEMA_VERSION,
    mode,
    summary: text(rawPlan.summary || rawPlan.reason, 500),
    requires_user_input: !!rawPlan.requires_user_input,
    user_input_reason: text(rawPlan.user_input_reason, 400),
    actions
  };
}

/** Convert today's legacy active_kit_actions into exact V25 controller actions when mapping IDs exist. */
export function legacyActionsToKitPlan(activeKitActions = [], kitContext = {}, { mode = "apply" } = {}) {
  const rawActions = [];
  for (const item of Array.isArray(activeKitActions) ? activeKitActions : []) {
    const kind = text(item?.action, 20).toLowerCase();
    if (!['add', 'remove'].includes(kind)) continue;
    const driverId = text(item?.builder_driver_id || item?.builderDriverId, 100);
    const productId = text(item?.builder_product_id || item?.builderProductId, 100);
    if (driverId && kind === 'add') {
      rawActions.push({ type: 'select_driver', driverId });
      continue;
    }
    if (productId) {
      rawActions.push({
        type: kind === 'remove' ? 'remove_product' : 'add_product',
        productId,
        quantity: integer(item?.qty ?? item?.quantity ?? 1, 1, 1000) || 1
      });
    }
  }
  return sanitizeKitPlan({ version:1, mode, actions:rawActions }, kitContext);
}

/** Prefer a native model kit_plan; otherwise upgrade safe mapped legacy actions. */
export function resolveKitPlanForPayload({ parsedResponse = {}, activeKitActions = [], kitContext = {} } = {}) {
  try {
    if (isPlainObject(parsedResponse?.kit_plan) && Array.isArray(parsedResponse.kit_plan.actions)) {
      return sanitizeKitPlan(parsedResponse.kit_plan, kitContext);
    }
  } catch (error) {
    return {
      version: KIT_CONTROLLER_SCHEMA_VERSION,
      mode: "guide",
      summary: "",
      actions: [],
      rejected: true,
      rejection_reason: text(error?.message || error, 400)
    };
  }

  try {
    const upgraded = legacyActionsToKitPlan(activeKitActions, kitContext, { mode:"apply" });
    return upgraded.actions.length ? upgraded : null;
  } catch {
    return null;
  }
}

/**
 * Add this string to the Kit Expert prompt. It expands the model schema without removing the
 * existing recommended_products / active_kit_actions fields, so deployment can be gradual.
 */
export function buildKitControllerPromptInstructions(kitContext = {}) {
  const controllerContext = buildKitControllerPromptContext(kitContext);
  return `\nKIT BUILDER CONTROLLER V25\n${JSON.stringify(controllerContext, null, 2)}\n\nWhen the user explicitly asks you to build, configure, apply, change, finish, fix, or control the kit, you MAY also return a kit_plan object.\nkit_plan schema:\n{\n  "mode": "guide | apply | auto_build",\n  "summary": "short purpose",\n  "requires_user_input": false,\n  "user_input_reason": "",\n  "actions": [\n    { "type": "select_application", "applicationId": "exact-id" },\n    { "type": "select_driver", "driverId": "exact-id", "applicationId": "optional-exact-id" },\n    { "type": "add_product", "productId": "exact-id", "quantity": 1 },\n    { "type": "remove_product", "productId": "exact-id" },\n    { "type": "set_product_quantity", "productId": "exact-id", "quantity": 1 },\n    { "type": "set_kit_quantity", "quantity": 1 },\n    { "type": "set_body_material", "value": "metal | nonconductive" },\n    { "type": "set_adapter", "voltage": 12, "currentA": 2, "suppliedSeparately": true },\n    { "type": "set_strip_load", "value": 7.5 },\n    { "type": "fill_required" },\n    { "type": "remove_optional" },\n    { "type": "go_to_category", "category": "led | battery | wiring | addons" },\n    { "type": "go_to_step", "step": 4 },\n    { "type": "open_product_options", "productId": "exact-id" },\n    { "type": "check_live_price" }\n  ]\n}\nController rules:\n- Use ONLY exact IDs present in KIT BUILDER CONTROLLER V25. Never make up IDs.\n- The browser performs the final deterministic compatibility check; do not claim a mutation succeeded before its result returns.\n- A full automatic build is allowed only when the user explicitly asks the assistant to build/configure it for them.\n- Stop and ask one concise question if a required choice is genuinely ambiguous. Do not guess LED wattage, battery variant/capacity, custom wire length, body material, or other product options.\n- It is valid to return a partial plan. The frontend can continue with a fresh context after visible execution.\n- Never place the final order or silently confirm the final cart mutation.\n`;
}

/** Optional low-cost diagnostic for logs/tests. */
export function summarizeKitPlan(plan = null) {
  if (!plan || !Array.isArray(plan.actions)) return { action_count:0, action_types:[] };
  return {
    action_count: plan.actions.length,
    action_types: plan.actions.map((a) => a.type),
    mode: plan.mode || "guide",
    rejected: !!plan.rejected
  };
}
