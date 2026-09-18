/*
  Smart Handicrafts Kit AI Controller V25.1 - server helper
  ---------------------------------------------------------
  Purpose:
  - Keep model-generated Kit Builder plans on a strict, exact-ID contract.
  - Make the Kit Builder planning catalogue the canonical product/action source.
  - Preserve explicit user build requirements across automatic continuation turns.
  - Prevent legacy recommendation/action paths from overriding a native controller plan.
  - Never validate electrical compatibility on the server by guessing. The browser
    Kit Builder remains the final deterministic authority and previews/executes every plan.

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

function rowsById(list = []) {
  const map = new Map();
  for (const row of Array.isArray(list) ? list : []) {
    const id = text(row?.id, 100);
    if (id) map.set(id, row);
  }
  return map;
}

function catalogMaps(catalog = {}) {
  return {
    applications: rowsById(catalog.applications),
    drivers: rowsById(catalog.drivers),
    products: rowsById(catalog.products),
    templates: rowsById(catalog.templates)
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

function compact(value = "") {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizedWords(value = "") {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function numberFromQuestion(question = "", pattern) {
  const match = String(question || "").match(pattern);
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) ? value : null;
}

function bodyMaterialFromQuestion(question = "") {
  const q = String(question || "").toLowerCase();
  if (/\b(metal|steel|brass|aluminium|aluminum|conductive)\b/.test(q)) return "metal";
  if (/\b(wood|wooden|ceramic|stone|plastic|acrylic|non[-\s]?conductive)\b/.test(q)) return "nonconductive";
  return "";
}

function bodyMaterialFromProjectState(projectState = {}) {
  const value = text(projectState?.body_material, 40).toLowerCase();
  if (value === "metal") return "metal";
  if (["wood", "ceramic", "stone", "plastic", "acrylic"].includes(value)) return "nonconductive";
  return "";
}

function batteryVariantFromQuestion(question = "") {
  const q = String(question || "").toLowerCase();
  if (/\b(without\s+sleeve|no\s+sleeve|non[-\s]?sleeve)\b/.test(q)) return "without_sleeve";
  if (/\b(with\s+sleeve|sleeve\s+battery)\b/.test(q)) return "with_sleeve";
  if (/\b(holder[-\s]?based|battery\s+holder|replaceable\s+battery)\b/.test(q)) return "holder_based";
  return "";
}

function findMentionedDriver(question = "", catalog = {}) {
  const qCompact = compact(question);
  if (!qCompact) return "";
  const drivers = [...(Array.isArray(catalog.drivers) ? catalog.drivers : [])]
    .sort((a, b) => Math.max(compact(b?.id).length, compact(b?.code).length) - Math.max(compact(a?.id).length, compact(a?.code).length));

  for (const driver of drivers) {
    const id = text(driver?.id, 100);
    const code = text(driver?.code, 120);
    const idCompact = compact(id);
    const codeCompact = compact(code);
    if (codeCompact && codeCompact.length >= 5 && qCompact.includes(codeCompact)) return id;
    if (idCompact && idCompact.length >= 4 && qCompact.includes(idCompact)) return id;
  }

  // Numeric driver IDs need a boundary-aware fallback so "201 LC" resolves to 201-lc first.
  const lc = String(question || "").match(/\b(201|202)\s*[- ]?\s*lc\b/i);
  if (lc) {
    const id = `${lc[1]}-lc`;
    if ((catalog.drivers || []).some((d) => d?.id === id)) return id;
  }
  const numeric = String(question || "").match(/\b(101|102|103|201|202|204|205)\b(?!\s*[- ]?\s*lc\b)/i);
  if (numeric && (catalog.drivers || []).some((d) => d?.id === numeric[1])) return numeric[1];

  return "";
}

function findMentionedApplication(question = "", catalog = {}) {
  const q = String(question || "").toLowerCase();
  const available = new Set((catalog.applications || []).map((a) => text(a?.id, 100)));
  if (/\brechargeable\b|\bcordless\b|\bbattery[-\s]?powered\b/.test(q) && available.has("rechargeable")) return "rechargeable";
  if (/\busb[-\s]?powered\b|\bdirect\s+usb\b|\bno\s+battery\b/.test(q) && available.has("usb-powered")) return "usb-powered";
  if (/\bstrip\b/.test(q) && available.has("strip-drivers")) return "strip-drivers";
  if (/\bdob\b/.test(q) && available.has("dob-drivers")) return "dob-drivers";

  const qCompact = compact(question);
  for (const app of catalog.applications || []) {
    const id = text(app?.id, 100);
    const name = text(app?.name, 180);
    if ((compact(id).length >= 5 && qCompact.includes(compact(id))) ||
        (compact(name).length >= 7 && qCompact.includes(compact(name)))) return id;
  }
  return "";
}

function productMatchesBatteryVariant(product = {}, variant = "") {
  if (!variant) return true;
  const hay = normalizedWords(`${product?.name || ""} ${product?.sku || ""}`);
  if (variant === "with_sleeve") return /\bsleeve\b/.test(hay) && !/\bwithout\b|\bno sleeve\b/.test(hay);
  if (variant === "without_sleeve") return /\bwithout sleeve\b|\bno sleeve\b/.test(hay);
  if (variant === "holder_based") return !!product?.needsHolder || /\bholder\b/.test(hay);
  return true;
}

function chooseGoalProduct({
  category,
  catalog = {},
  driverId = "",
  watt = null,
  mah = null,
  diameterMm = null,
  batteryVariant = "",
  preferredId = ""
} = {}) {
  const products = Array.isArray(catalog.products) ? catalog.products : [];
  const driver = (catalog.drivers || []).find((d) => d?.id === driverId) || null;
  const supported = new Set(Array.isArray(driver?.supports) ? driver.supports : []);

  if (preferredId) {
    const preferred = products.find((p) => p?.id === preferredId);
    if (preferred && preferred.category === category &&
        (!driver || !supported.size || supported.has(preferred.id))) {
      if (watt != null && Number(preferred.watt || 0) !== Number(watt)) return "";
      if (mah != null && Number(preferred.mah || 0) !== Number(mah)) return "";
      if (category === "battery" && !productMatchesBatteryVariant(preferred, batteryVariant)) return "";
      return preferred.id;
    }
  }

  let candidates = products.filter((p) => p && p.category === category);
  if (driver && supported.size) candidates = candidates.filter((p) => supported.has(p.id));
  if (watt != null) candidates = candidates.filter((p) => Number(p.watt || 0) === Number(watt));
  if (mah != null) candidates = candidates.filter((p) => Number(p.mah || 0) === Number(mah));
  if (category === "battery" && batteryVariant) {
    const byVariant = candidates.filter((p) => productMatchesBatteryVariant(p, batteryVariant));
    if (byVariant.length) candidates = byVariant;
  }
  if (diameterMm != null && category === "led") {
    const byDiameter = candidates.filter((p) => {
      const name = normalizedWords(p?.name || "");
      return name.includes(`${Number(diameterMm)}mm`) ||
        name.includes(`${Number(diameterMm)} mm`) ||
        new RegExp(`\\b${Number(diameterMm)}\\s*mm\\b`, "i").test(p?.name || "");
    });
    if (byDiameter.length) candidates = byDiameter;
  }

  return candidates.length === 1 ? text(candidates[0]?.id, 100) : "";
}

function sanitizeBuildGoal(rawGoal = {}, kitContext = {}) {
  const catalog = planningCatalogFrom(kitContext);
  const ids = mapsFromCatalog(catalog);
  const goal = isPlainObject(rawGoal) ? rawGoal : {};

  const out = {
    version: 1,
    locked: goal.locked === true,
    source: text(goal.source, 80),
    applicationId: text(goal.applicationId || goal.application_id, 100),
    driverId: text(goal.driverId || goal.driver_id, 100),
    ledProductId: text(goal.ledProductId || goal.led_product_id, 100),
    batteryProductId: text(goal.batteryProductId || goal.battery_product_id, 100),
    desiredLedWattageW: finiteNumber(goal.desiredLedWattageW ?? goal.desired_led_wattage_w, 0.1, 100),
    ledDiameterMm: finiteNumber(goal.ledDiameterMm ?? goal.led_diameter_mm, 1, 1000),
    batteryMah: finiteNumber(goal.batteryMah ?? goal.battery_capacity_mah, 100, 100000),
    batteryVariant: text(goal.batteryVariant || goal.battery_variant, 40).toLowerCase(),
    bodyMaterial: text(goal.bodyMaterial || goal.body_material, 40).toLowerCase(),
    originalUserRequest: text(goal.originalUserRequest || goal.original_user_request, 1600),
    coreResolved: goal.coreResolved === true
  };

  if (out.applicationId && !ids.applications.has(out.applicationId)) out.applicationId = "";
  if (out.driverId && !ids.drivers.has(out.driverId)) out.driverId = "";
  if (out.ledProductId && !ids.products.has(out.ledProductId)) out.ledProductId = "";
  if (out.batteryProductId && !ids.products.has(out.batteryProductId)) out.batteryProductId = "";
  if (!BODY_MATERIAL_SET.has(out.bodyMaterial)) out.bodyMaterial = "";
  if (!["with_sleeve", "without_sleeve", "holder_based", ""].includes(out.batteryVariant)) out.batteryVariant = "";
  return out;
}

/**
 * Create/preserve an immutable controller build goal.
 * Current-turn explicit facts override an incoming goal. Otherwise the incoming goal
 * outranks project-state/current-builder drift during auto continuation.
 */
export function deriveKitBuildGoal({
  question = "",
  projectState = null,
  kitContext = {},
  incomingBuildGoal = null
} = {}) {
  const catalog = planningCatalogFrom(kitContext);
  const maps = catalogMaps(catalog);
  const incoming = sanitizeBuildGoal(incomingBuildGoal || {}, kitContext);
  const q = String(question || "");

  const explicitApplicationId = findMentionedApplication(q, catalog);
  const explicitDriverId = findMentionedDriver(q, catalog);
  const explicitWatt = numberFromQuestion(q, /\b(\d+(?:\.\d+)?)\s*w(?:att)?\b/i);
  const explicitBatteryMah = numberFromQuestion(q, /\b(\d{3,5})\s*mah\b/i);
  const explicitDiameter = numberFromQuestion(q, /\b(\d+(?:\.\d+)?)\s*mm\b/i);
  const explicitBatteryVariant = batteryVariantFromQuestion(q);
  const explicitBody = bodyMaterialFromQuestion(q);

  const state = isPlainObject(projectState) ? projectState : {};
  const stateApplication =
    state.power_type === "rechargeable" ? "rechargeable" :
    state.power_type === "usb_powered" ? "usb-powered" : "";

  const goal = {
    version: 1,
    locked: incoming.locked === true,
    source: incoming.source || "",
    applicationId: explicitApplicationId || incoming.applicationId || (maps.applications.has(stateApplication) ? stateApplication : ""),
    driverId: explicitDriverId || incoming.driverId || "",
    desiredLedWattageW: explicitWatt ?? incoming.desiredLedWattageW ??
      (Number.isFinite(Number(state.desired_led_wattage_w)) ? Number(state.desired_led_wattage_w) : null),
    ledDiameterMm: explicitDiameter ?? incoming.ledDiameterMm ??
      (Number.isFinite(Number(state.head_diameter_mm)) && Number(state.head_diameter_mm) <= 80 ? Number(state.head_diameter_mm) : null),
    batteryMah: explicitBatteryMah ?? incoming.batteryMah ??
      (Number.isFinite(Number(state.battery_capacity_mah)) ? Number(state.battery_capacity_mah) : null),
    batteryVariant: explicitBatteryVariant || incoming.batteryVariant ||
      (["with_sleeve", "without_sleeve", "holder_based"].includes(String(state.battery_variant || "")) ? String(state.battery_variant) : ""),
    bodyMaterial: explicitBody || incoming.bodyMaterial || bodyMaterialFromProjectState(state),
    ledProductId: incoming.ledProductId || "",
    batteryProductId: incoming.batteryProductId || "",
    originalUserRequest: incoming.originalUserRequest || text(q, 1600),
    coreResolved: false
  };

  goal.ledProductId = chooseGoalProduct({
    category: "led",
    catalog,
    driverId: goal.driverId,
    watt: goal.desiredLedWattageW,
    diameterMm: goal.ledDiameterMm,
    preferredId: goal.ledProductId
  });

  goal.batteryProductId = chooseGoalProduct({
    category: "battery",
    catalog,
    driverId: goal.driverId,
    mah: goal.batteryMah,
    batteryVariant: goal.batteryVariant,
    preferredId: goal.batteryProductId
  });

  const currentTurnHasExplicitConstraint = !!(
    explicitApplicationId || explicitDriverId || explicitWatt != null ||
    explicitBatteryMah != null || explicitBatteryVariant || explicitBody
  );
  goal.locked = incoming.locked === true || currentTurnHasExplicitConstraint;
  goal.source = currentTurnHasExplicitConstraint ? "current_user_requirements" :
    (incoming.locked ? "preserved_auto_build_goal" : "project_state");

  const driver = maps.drivers.get(goal.driverId) || null;
  const requiresBattery = !!driver && !["usb", "direct"].includes(String(driver.family || "").toLowerCase());
  const requiresExternalLed = !!driver && String(driver.family || "").toLowerCase() !== "dob";
  const requiresBodyMaterial = !!driver?.touchRequired;

  goal.coreResolved = !!(
    goal.applicationId &&
    goal.driverId &&
    (!requiresExternalLed || goal.ledProductId) &&
    (!requiresBattery || goal.batteryProductId) &&
    (!requiresBodyMaterial || goal.bodyMaterial)
  );

  return sanitizeBuildGoal(goal, kitContext);
}

/**
 * A compact prompt-safe controller context. Unlike V25.0, this also includes the
 * full exact planning driver/product IDs so an empty builder can still be planned
 * without falling back to fuzzy Odoo names.
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
    needsHolder: !!p.needsHolder,
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
    maxWatt: Number.isFinite(Number(d.maxWatt)) ? Number(d.maxWatt) : null,
    touchRequired: !!d.touchRequired,
    supports: Array.isArray(d.supports) ? d.supports.map((x) => text(x, 100)).filter(Boolean).slice(0, 100) : []
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
    catalog_drivers: (Array.isArray(catalog.drivers) ? catalog.drivers : []).slice(0, 40).map(compactDriver),
    catalog_products: (Array.isArray(catalog.products) ? catalog.products : []).slice(0, 180).map(compactProduct),
    templates: (Array.isArray(catalog.templates) ? catalog.templates : []).slice(0, 40).map((t) => ({
      id: text(t?.id, 100), name: text(t?.name, 180), appId: text(t?.appId, 100), driverId: text(t?.driverId, 100)
    })),
    supported_actions: Array.isArray(contract.actions) && contract.actions.length
      ? contract.actions.filter((x) => ACTION_SET.has(text(x, 80))).slice(0, 30)
      : KIT_CONTROLLER_ACTION_TYPES,
    safety: [
      "Use exact Kit Builder IDs only; never invent an id, SKU, option value, or compatibility fact.",
      "Current-turn explicit requirements and a preserved build_goal outrank stale builder/conversation selections.",
      "Do not bypass ambiguity. Ask before choosing an unresolved LED wattage, battery variant/capacity, body material, custom length, or other required option.",
      "Products with live Odoo options may be selected, but option values must be chosen in the visible Odoo/Kit Builder option UI; never invent a length.",
      "The browser Kit Builder previews and validates every action and remains the final authority.",
      "Do not automatically confirm the final cart mutation. check_live_price only opens/verifies the review path."
    ]
  };
}

/**
 * Strictly validate a model-provided kit_plan against exact IDs from the browser planning catalog.
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

function actionKey(action = {}) {
  switch (action.type) {
    case "select_application": return `select_application:${action.applicationId}`;
    case "select_driver": return `select_driver:${action.driverId}`;
    case "add_product":
    case "remove_product":
    case "set_product_quantity":
    case "open_product_options": return `${action.type}:${action.productId}`;
    case "set_body_material": return `set_body_material:${action.value}`;
    case "fill_required": return "fill_required";
    case "go_to_step": return `go_to_step:${action.step}`;
    case "go_to_category": return `go_to_category:${action.category}`;
    default: return JSON.stringify(action);
  }
}

function addUnique(target, seen, action) {
  const key = actionKey(action);
  if (seen.has(key)) return;
  seen.add(key);
  target.push(action);
}

/**
 * Deterministically repair a model plan toward the immutable user build goal.
 * This is not compatibility inference: it only chooses exact catalogue IDs already
 * resolved by deriveKitBuildGoal; the browser engine still validates the result.
 */
export function reconcileKitPlanWithBuildGoal(plan, rawGoal = null, kitContext = {}) {
  if (!plan || !Array.isArray(plan.actions)) return plan;
  const goal = sanitizeBuildGoal(rawGoal || {}, kitContext);
  if (!goal.locked) return plan;

  const snapshot = snapshotFrom(kitContext);
  const catalog = planningCatalogFrom(kitContext);
  const maps = catalogMaps(catalog);
  const selectedIds = new Set(Array.isArray(snapshot.selectedItemIds) ? snapshot.selectedItemIds.map(String) : []);
  const result = [];
  const tail = [];
  const seen = new Set();

  const goalLed = goal.ledProductId ? maps.products.get(goal.ledProductId) : null;
  const goalBattery = goal.batteryProductId ? maps.products.get(goal.batteryProductId) : null;

  if (goal.applicationId && snapshot.selectedApplicationId !== goal.applicationId) {
    addUnique(result, seen, { type: "select_application", applicationId: goal.applicationId });
  }
  if (goal.driverId && snapshot.selectedDriverId !== goal.driverId) {
    addUnique(result, seen, { type: "select_driver", driverId: goal.driverId, ...(goal.applicationId ? { applicationId: goal.applicationId } : {}) });
  }

  // Remove a stale core selection before adding the explicit goal product.
  if (goalLed) {
    for (const selectedId of selectedIds) {
      const p = maps.products.get(selectedId);
      if (p?.category === "led" && selectedId !== goal.ledProductId) {
        addUnique(result, seen, { type: "remove_product", productId: selectedId });
      }
    }
    if (!selectedIds.has(goal.ledProductId)) {
      addUnique(result, seen, { type: "add_product", productId: goal.ledProductId, quantity: 1 });
    }
  }
  if (goalBattery) {
    for (const selectedId of selectedIds) {
      const p = maps.products.get(selectedId);
      if (p?.category === "battery" && selectedId !== goal.batteryProductId) {
        addUnique(result, seen, { type: "remove_product", productId: selectedId });
      }
    }
    if (!selectedIds.has(goal.batteryProductId)) {
      addUnique(result, seen, { type: "add_product", productId: goal.batteryProductId, quantity: 1 });
    }
  }
  if (goal.bodyMaterial && snapshot?.kit?.bodyMaterial !== goal.bodyMaterial) {
    addUnique(result, seen, { type: "set_body_material", value: goal.bodyMaterial });
  }

  for (const action of plan.actions) {
    if (goal.applicationId && action.type === "select_application") continue;
    if (goal.driverId && action.type === "select_driver") continue;
    if (goal.bodyMaterial && action.type === "set_body_material") continue;

    if (["add_product", "remove_product", "set_product_quantity", "open_product_options"].includes(action.type)) {
      const product = maps.products.get(action.productId);
      if (product?.category === "led" && goal.ledProductId) {
        if (action.productId !== goal.ledProductId) continue;
        if (action.type === "remove_product") continue;
      }
      if (product?.category === "battery" && goal.batteryProductId) {
        if (action.productId !== goal.batteryProductId) continue;
        if (action.type === "remove_product") continue;
      }
    }

    // Navigation/live-check actions should remain last.
    if (["go_to_step", "go_to_category", "open_product_options", "check_live_price", "save_kit"].includes(action.type)) {
      tail.push(action);
      continue;
    }
    addUnique(result, seen, action);
  }

  if (plan.mode === "auto_build" && goal.coreResolved && !result.some((a) => a.type === "fill_required")) {
    addUnique(result, seen, { type: "fill_required" });
  }
  for (const action of tail) addUnique(result, seen, action);

  // Final contradiction assertions. If a contradiction survived, reject rather than guess.
  for (const action of result) {
    if (goal.applicationId && action.type === "select_application" && action.applicationId !== goal.applicationId) {
      throw new Error(`Plan conflicts with requested application ${goal.applicationId}.`);
    }
    if (goal.driverId && action.type === "select_driver" && action.driverId !== goal.driverId) {
      throw new Error(`Plan conflicts with requested driver ${goal.driverId}.`);
    }
    if (goal.bodyMaterial && action.type === "set_body_material" && action.value !== goal.bodyMaterial) {
      throw new Error(`Plan conflicts with requested body material ${goal.bodyMaterial}.`);
    }
    if (action.type === "add_product") {
      const p = maps.products.get(action.productId);
      if (p?.category === "led" && goal.desiredLedWattageW != null && Number(p.watt || 0) !== Number(goal.desiredLedWattageW)) {
        throw new Error(`Plan LED ${action.productId} conflicts with requested ${goal.desiredLedWattageW}W.`);
      }
      if (p?.category === "battery" && goal.batteryMah != null && Number(p.mah || 0) !== Number(goal.batteryMah)) {
        throw new Error(`Plan battery ${action.productId} conflicts with requested ${goal.batteryMah}mAh.`);
      }
    }
  }

  return {
    ...plan,
    summary: plan.summary || "Apply the user's exact preserved Kit Builder requirements.",
    actions: result,
    build_goal_applied: true
  };
}

/** Convert legacy active_kit_actions into exact controller actions only when explicitly allowed. */
export function legacyActionsToKitPlan(activeKitActions = [], kitContext = {}, { mode = "apply" } = {}) {
  const rawActions = [];
  for (const item of Array.isArray(activeKitActions) ? activeKitActions : []) {
    const kind = text(item?.action, 20).toLowerCase();
    if (!["add", "remove"].includes(kind)) continue;
    const driverId = text(item?.builder_driver_id || item?.builderDriverId, 100);
    const productId = text(item?.builder_product_id || item?.builderProductId, 100);
    if (driverId && kind === "add") {
      rawActions.push({ type: "select_driver", driverId });
      continue;
    }
    if (productId) {
      rawActions.push({
        type: kind === "remove" ? "remove_product" : "add_product",
        productId,
        quantity: integer(item?.qty ?? item?.quantity ?? 1, 1, 1000) || 1
      });
    }
  }
  return sanitizeKitPlan({ version: 1, mode, actions: rawActions }, kitContext);
}

/**
 * Prefer a native model kit_plan. In controller mode, legacy active_kit_actions are
 * NOT silently upgraded unless allowLegacyFallback is explicitly true.
 */
export function resolveKitPlanForPayload({
  parsedResponse = {},
  activeKitActions = [],
  kitContext = {},
  buildGoal = null,
  controllerMode = false,
  allowLegacyFallback = true
} = {}) {
  try {
    if (isPlainObject(parsedResponse?.kit_plan) && Array.isArray(parsedResponse.kit_plan.actions)) {
      const sanitized = sanitizeKitPlan(parsedResponse.kit_plan, kitContext);
      return reconcileKitPlanWithBuildGoal(sanitized, buildGoal, kitContext);
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

  if (controllerMode && !allowLegacyFallback) return null;
  if (!allowLegacyFallback) return null;

  try {
    const upgraded = legacyActionsToKitPlan(activeKitActions, kitContext, { mode: "apply" });
    const reconciled = reconcileKitPlanWithBuildGoal(upgraded, buildGoal, kitContext);
    return reconciled.actions.length ? reconciled : null;
  } catch {
    return null;
  }
}

/**
 * Add exact controller catalogue + immutable build-goal instructions to the Kit Expert prompt.
 */
export function buildKitControllerPromptInstructions(kitContext = {}, buildGoal = null) {
  const controllerContext = buildKitControllerPromptContext(kitContext);
  const goal = sanitizeBuildGoal(buildGoal || {}, kitContext);
  return `
KIT BUILDER CONTROLLER V25.1
${JSON.stringify(controllerContext, null, 2)}

IMMUTABLE BUILD GOAL FOR THIS AUTO/APPLY RUN:
${JSON.stringify(goal, null, 2)}

When the user explicitly asks you to build, configure, apply, change, finish, fix, or control the kit, return a kit_plan object.
kit_plan schema:
{
  "mode": "guide | apply | auto_build",
  "summary": "short purpose",
  "requires_user_input": false,
  "user_input_reason": "",
  "actions": [
    { "type": "select_application", "applicationId": "exact-id" },
    { "type": "select_driver", "driverId": "exact-id", "applicationId": "optional-exact-id" },
    { "type": "add_product", "productId": "exact-id", "quantity": 1 },
    { "type": "remove_product", "productId": "exact-id" },
    { "type": "set_product_quantity", "productId": "exact-id", "quantity": 1 },
    { "type": "set_kit_quantity", "quantity": 1 },
    { "type": "set_body_material", "value": "metal | nonconductive" },
    { "type": "set_adapter", "voltage": 12, "currentA": 2, "suppliedSeparately": true },
    { "type": "set_strip_load", "value": 7.5 },
    { "type": "fill_required" },
    { "type": "remove_optional" },
    { "type": "go_to_category", "category": "led | battery | wiring | addons" },
    { "type": "go_to_step", "step": 4 },
    { "type": "open_product_options", "productId": "exact-id" },
    { "type": "check_live_price" }
  ]
}
Controller rules:
- Use ONLY exact IDs from catalog_drivers/catalog_products/applications/templates above. Never make up IDs.
- When bridge_available is true, kit_plan is the ONLY mutation contract. active_kit_actions/recommended_products are informational/backward-compatible and must not be relied on to control V25.
- Current-turn explicit requirements and the IMMUTABLE BUILD GOAL outrank stale/current builder selections. If the builder conflicts with the goal, plan a visible correction instead of adopting the wrong builder value.
- Never change a requested driver, LED wattage/product, battery capacity/product, or body material by inference. For example a 2W goal must never become 3W.
- If the goal already resolves an exact battery/LED ID, do not ask permission to add that same product again.
- Use fill_required for deterministic dependencies rather than inventing each dependency. The browser engine decides required JST/touch/holder/grommet dependencies.
- A product that requires live options may be selected, but NEVER invent option values or custom lengths. Use open_product_options when that selected product needs a user option.
- Mentioning a product in a conditional example (for example "if Lug Wire length needs my choice, ask me") is NOT a request to add that product.
- The browser performs final deterministic compatibility validation; do not claim success before its result returns.
- A full automatic build is allowed only when the user explicitly asks the assistant to build/configure it for them.
- Stop and ask one concise question only if a genuinely unresolved required choice remains.
- It is valid to return a partial plan. The frontend can continue with fresh verified context after visible execution.
- Never place the final order or silently confirm the final cart mutation.
`.trim();
}

/** Optional low-cost diagnostic for logs/tests. */
export function summarizeKitPlan(plan = null) {
  if (!plan || !Array.isArray(plan.actions)) return { action_count: 0, action_types: [] };
  return {
    action_count: plan.actions.length,
    action_types: plan.actions.map((a) => a.type),
    mode: plan.mode || "guide",
    rejected: !!plan.rejected,
    build_goal_applied: !!plan.build_goal_applied
  };
}
