import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import Handlebars from "handlebars";
import { JSDOM } from "jsdom";
import { activeUseCount, d20ModifierParts, isRunActive, itemUses, resourceBonus } from "../scripts/logic.js";

const source = await readFile(new URL("../scripts/quick-battles.js", import.meta.url), "utf8");
const html = await readFile(new URL("../templates/quick-battles.hbs", import.meta.url), "utf8");
Handlebars.registerHelper("signed", (value) => `${Number(value) >= 0 ? "+" : ""}${Number(value) || 0}`);
const template = Handlebars.compile(html);
const part = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));

test("participant totals remain outside the scroll area and the resource limit disables rolling live", () => {
  const dom = new JSDOM(template({
    isParticipant: true,
    actor: { name: "Hero", hp: 20, ac: 14 },
    passive: { abilityName: "STR", ability: 3, hp: 0, armor: -1, total: 2 },
    passiveEntries: [], activeItems: [{ name: "Rage", itemId: "rage", bonusPerUse: 2, available: 3 }],
    spellSlots: [{ level: 1, bonus: 1, available: 2 }], maxActiveUses: 2, dc: 15
  }));
  const root = dom.window.document.querySelector(".qb-check-form");
  assert.ok(root.querySelector(".qb-check-totals [data-active-bonus-preview]"));
  assert.ok(root.querySelector(".qb-check-scroll .qb-bonus-list"));
  assert.equal(root.querySelector(".qb-check-scroll [data-active-bonus-preview]"), null);
  const button = root.querySelector('[data-app-action="submit-check"]');
  assert.equal(button.textContent, "Roll vs DC 15");
  const context = { resourceBonus, activeUseCount };
  vm.createContext(context);
  vm.runInContext(`${part("function updateActiveBonusPreview(", "\nfunction createButton(")}\nthis.update = updateActiveBonusPreview;`, context);
  const [active, slot] = root.querySelectorAll("[data-bonus-count]");
  active.value = "2";
  slot.value = "1";
  context.update(root);
  assert.equal(button.disabled, true);
  assert.equal(root.querySelector("[data-bonus-total]").textContent, "+5");
  assert.equal(root.querySelector("[data-combined-bonus]").textContent, "+7");
  assert.equal(root.querySelector("[data-active-use-feedback]").textContent, "3/2 active resources");
  slot.value = "0";
  context.update(root);
  assert.equal(button.disabled, false);
  assert.equal(root.querySelector("[data-bonus-total]").textContent, "+4");
  assert.equal(root.querySelector("[data-combined-bonus]").textContent, "+6");
});

test("active feature steppers change values by one within resource bounds and update totals", async () => {
  const dom = new JSDOM(template({
    isParticipant: true, actor: { name: "Hero" },
    passive: { abilityName: "STR", total: 1 }, passiveEntries: [],
    activeItems: [{ name: "Rage", itemId: "rage", bonusPerUse: 2, available: 2 }],
    spellSlots: [], maxActiveUses: 1, dc: 15
  }));
  class ApplicationV2 { constructor(options) { this.options = options; } async _onRender() {} }
  const context = {
    foundry: { applications: { api: { ApplicationV2, HandlebarsApplicationMixin: (base) => base } } },
    MODULE_ID: "test", TEMPLATE: "template", activeUseCount, resourceBonus
  };
  vm.createContext(context);
  vm.runInContext(`${part("function updateActiveBonusPreview(", "\nfunction createButton(")}\n${part("class QuickBattlesApplication", "\nfunction renderParticipantResult(")}\nthis.App = QuickBattlesApplication;`, context);
  const app = new context.App({ mode: "participant" });
  app.element = dom.window.document.querySelector(".qb-shell");
  await app._onRender({}, {});
  const increase = app.element.querySelector('[data-resource-step="1"]');
  const decrease = app.element.querySelector('[data-resource-step="-1"]');
  const input = app.element.querySelector('[name="active-rage"]');
  decrease.click();
  assert.equal(input.value, "0");
  increase.click();
  assert.equal(input.value, "1");
  assert.equal(app.element.querySelector("[data-combined-bonus]").textContent, "+3");
  increase.click();
  increase.click();
  assert.equal(input.value, "2");
  assert.equal(app.element.querySelector('[data-app-action="submit-check"]').disabled, true);
  decrease.click();
  assert.equal(input.value, "1");
  assert.equal(app.element.querySelector('[data-app-action="submit-check"]').disabled, false);
});

test("active spend plans retain D&D 5e spent updates and record each selected bonus", () => {
  class ApplicationV2 { constructor(options) { this.options = options; } }
  const context = {
    foundry: { applications: { api: { ApplicationV2, HandlebarsApplicationMixin: (base) => base } } },
    MODULE_ID: "test", TEMPLATE: "template", itemUses,
    CSS: { escape: (value) => value }, numberValue: (value) => Number(value)
  };
  vm.createContext(context);
  vm.runInContext(`${part("class QuickBattlesApplication", "\nfunction renderParticipantResult(")}\nthis.App = QuickBattlesApplication;`, context);
  const app = new context.App({ mode: "participant" });
  app.element = { querySelector: () => ({ value: "2" }) };
  const actor = { items: new Map([["rage", { id: "rage", system: { uses: { max: 4, spent: 1, value: 3 } } }]]) };
  const plan = app._activeSpendPlan(actor, [{ itemId: "rage", name: "Rage", available: 3, bonusPerUse: 2 }]);
  assert.equal(plan.count, 2);
  assert.equal(plan.bonus, 4);
  assert.equal(plan.updates[0]["system.uses.spent"], 3);
  assert.equal(plan.entries[0].name, "Rage × 2");
  assert.equal(plan.entries[0].bonus, 4);
});

test("GM party shows selection before checks and status cards with damage after checks", () => {
  const actor = { uuid: "Actor.1", name: "Hero", img: "hero.png", level: 5, hp: 12, maxHp: 20, ac: 16, defaultSelected: true };
  const base = {
    showCurrentRun: true, showEncounter: true, canStartChecks: true,
    state: { fate: { dc: 10 }, fateResult: { failed: true }, selectedEncounter: { name: "Wolves", dc: 15 } },
    groups: [{ id: "main", name: "Main" }], actors: [actor]
  };
  const selecting = new JSDOM(template(base)).window.document;
  assert.ok(selecting.querySelector(".qb-primary-column .qb-encounter-section"));
  assert.ok(selecting.querySelector(".qb-secondary-column .qb-participant"));
  assert.equal(selecting.querySelector('[data-app-action="start-checks"]').textContent, "Start Participant Checks");
  const resolved = new JSDOM(template({
    ...base, checksStarted: true, checksComplete: true,
    actors: [{ ...actor, status: "failed", checkStatus: "Failed (10)", damage: 4, canApplyDamage: true }]
  })).window.document;
  assert.equal(resolved.querySelector(".qb-combat-complete").textContent, "Combat complete");
  assert.equal(resolved.querySelector(".qb-party-card img").getAttribute("src"), "hero.png");
  assert.match(resolved.querySelector(".qb-party-card").textContent, /Hero \(Level 5\)/);
  assert.match(resolved.querySelector(".qb-party-card").textContent, /HP 12\/20 · AC 16/);
  assert.ok(resolved.querySelector(".qb-party-card-action .qb-damage-button"));
  assert.ok(resolved.querySelector(".qb-primary-column select").disabled);
  for (const control of resolved.querySelectorAll(".qb-primary-column button, .qb-primary-column input, .qb-primary-column select")) {
    if (control.dataset.appAction !== "new-battle") assert.equal(control.disabled, true);
  }
  assert.ok(resolved.querySelector(".qb-party-status-failed"));
  assert.ok(resolved.querySelector('[data-app-action="apply-party-damage"]'));
  assert.equal(resolved.querySelector('[data-app-action="start-checks"]'), null);
  assert.ok(resolved.querySelector('[data-app-action="new-battle"]'));
  assert.doesNotMatch(part("async function processParticipantSubmission(", "\nasync function applyPartyDamage("), /damage-control|createDamageControl/);
});

test("GM retains no-threat and completed runs until reset", async () => {
  let run = { id: "run", status: "fate-resolved", fate: {}, fateResult: { failed: false }, checks: {} };
  class ApplicationV2 { constructor(options) { this.options = options; } async render() {} }
  const context = {
    foundry: { applications: { api: { ApplicationV2, HandlebarsApplicationMixin: (base) => base } } },
    MODULE_ID: "test", TEMPLATE: "template", DEFAULT_LAST_SELECTION: {}, isRunActive,
    readConfig: async () => ({ players: [], encounterGroups: [], fateDcs: { easy: 10, medium: 13, hard: 16 } }),
    game: { settings: { get: () => ({}) }, user: { isGM: true } },
    currentRun: async (id) => !id || id === run.id ? { run, message: null } : null,
    persistRun: async (next) => { run = next; },
    statusLabel: () => "", enqueueSubmission: (operation) => operation()
  };
  vm.createContext(context);
  vm.runInContext(`${part("class QuickBattlesApplication", "\nfunction renderParticipantResult(")}\nthis.App = QuickBattlesApplication;`, context);
  const app = new context.App();
  const state = await app._prepareContext();
  assert.equal(state.showCurrentRun, true);
  assert.equal(state.noThreat, true);
  await app._newBattle();
  assert.equal(run.status, "reset");
  assert.equal((await app._prepareContext()).showCurrentRun, false);
  run = { id: "next", status: "checks-resolved", fate: {}, fateResult: { failed: true }, selectedEncounter: {}, checks: {} };
  assert.equal((await app._prepareContext()).checksComplete, true);
  assert.equal((await app._prepareContext()).showCurrentRun, true);
  run.checks.hero = { status: "failed", damage: 5, damageApplied: false };
  const dom = new JSDOM(template({}));
  app.element = dom.window.document;
  const dialog = app.element.querySelector("[data-reset-confirm-dialog]");
  dialog.showModal = () => {
    dialog.returnValue = "cancel";
    dialog.dispatchEvent(new dom.window.Event("close"));
  };
  await app._newBattle();
  assert.equal(run.status, "checks-resolved");
  dialog.showModal = () => {
    dialog.returnValue = "confirm";
    dialog.dispatchEvent(new dom.window.Event("close"));
  };
  await app._newBattle();
  assert.equal(run.status, "reset");
});

test("GM window starts narrow and expands for a run without overriding later manual resizing", async () => {
  const widths = [];
  class ApplicationV2 {
    constructor(options) { this.options = options; }
    async _onRender() {}
    setPosition(position) { widths.push(position.width); }
  }
  const context = {
    foundry: { applications: { api: { ApplicationV2, HandlebarsApplicationMixin: (base) => base } } },
    MODULE_ID: "test", TEMPLATE: "template", window: { innerWidth: 1400 }
  };
  vm.createContext(context);
  vm.runInContext(`${part("class QuickBattlesApplication", "\nfunction renderParticipantResult(")}\nthis.App = QuickBattlesApplication;`, context);
  const app = new context.App();
  app.element = { dataset: { qbBound: "true" } };
  await app._onRender({ showCurrentRun: false }, {});
  await app._onRender({ showCurrentRun: true }, {});
  await app._onRender({ showCurrentRun: true }, {});
  await app._onRender({ showCurrentRun: false }, {});
  assert.deepEqual(widths, [480, 960, 480]);
});

test("Fate modifier is shown in native roll and is applied only once", async () => {
  let run = { id: "run", status: "fate-pending", fate: {
    requestId: "request", selectedUserId: "user", pace: "normal", paceModifier: -2,
    situational: 1, campModifier: 3
  } };
  let sent, modifier, finished;
  const message = { flags: { test: { status: "pending" } } };
  const context = {
    MODULE_ID: "test", inFlight: new Set(), game: { user: { id: "user", isGM: false }, users: { get: () => ({ id: "user", isGM: false }) } },
    ui: { notifications: { warn() {} } }, gmUserIds: () => ["gm"],
    findMessageByFlag: () => message,
    currentRun: async () => ({ run, message: null }),
    nativeD20: async (_actor, value) => { modifier = value; return { toMessage: async (data) => { sent = data; } }; },
    chatMessageAuthorId: () => "user", submittedRoll: () => 14,
    persistRun: async (next) => { run = next; }, finishFate: async (next) => { finished = next; }
  };
  vm.createContext(context);
  vm.runInContext(`${part("async function submitFateRoll(", "\nasync function submitStealthRoll(")}\n${part("async function processFateSubmission(", "\nasync function processStealthSubmission(")}\nthis.submit = submitFateRoll; this.process = processFateSubmission;`, context);
  await context.submit("run", "request", "user");
  assert.deepEqual(Array.from(modifier), [-2, 1, 3]);
  assert.equal(sent.flags.test.includesFateModifiers, true);
  await context.process({ id: "message" }, sent.flags.test);
  assert.equal(finished.fate.d20, 12);
  assert.equal(finished.fate.d20 + modifier.reduce((sum, part) => sum + part, 0), 14);
  run.status = "fate-pending";
  await context.process({ id: "legacy" }, { ...sent.flags.test, includesFateModifiers: false });
  assert.equal(finished.fate.d20, 14);
});

test("native Fate roll retains each nonzero modifier in the formula", async () => {
  let parts;
  const context = {
    d20ModifierParts,
    CONFIG: { Dice: { D20Roll: { build: async (options) => { parts = options.rolls[0].parts; return [{}]; } } } },
    ChatMessage: { getSpeaker: () => ({}) }
  };
  vm.createContext(context);
  vm.runInContext(`${part("async function nativeD20(", "\nfunction normalizeConfig(")}\nthis.roll = nativeD20;`, context);
  await context.roll(null, [-2, 0, 3], "Fate");
  assert.deepEqual(Array.from(parts), ["-2", "3"]);
});

test("participant chat separates aligned bonuses and shows the actual active d20 before the outcome", () => {
  const context = {
    escapeHtml: (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]),
    chatCard: (content) => `<article>${content}</article>`
  };
  vm.createContext(context);
  vm.runInContext(`${part("function participantDice(", "\nasync function cardAction(")}\nthis.dice = participantDice; this.render = renderParticipantResult;`, context);
  const dice = context.dice({ dice: [{ faces: 20, results: [{ result: 3, active: false }, { result: 17, active: true }] }] });
  assert.deepEqual(Array.from(dice), [17]);
  const details = {
    actorName: "Hero", actorImg: "hero.png", dc: 15, total: 25, passed: true,
    passive: { abilityName: "STR", ability: 3, hp: 0, armor: -1, total: 3 },
    passiveEntries: [{ name: "Aura", bonus: 1 }],
    activeEntries: [{ name: "Rage × 2", bonus: 4 }, { name: "Level 1 spell slot × 1", bonus: 1 }],
    activeBonus: 4, slotBonus: 1, situational: 0, dice
  };
  const document = new JSDOM(context.render(details, false)).window.document;
  const columns = document.querySelectorAll(".qb-check-breakdowns section");
  assert.equal(columns.length, 2);
  assert.match(columns[0].textContent, /Aura/);
  assert.match(columns[1].textContent, /Rage × 2/);
  assert.equal(columns[1].querySelectorAll("dt").length, columns[1].querySelectorAll("dd").length);
  assert.equal(document.querySelector(".qb-check-dice").textContent, "d20: 17");
  assert.ok(document.querySelector(".qb-check-dice").compareDocumentPosition(document.querySelector(".qb-check-roll")) & 4);
  const legacy = new JSDOM(context.render({ ...details, activeEntries: undefined, dice: undefined }, false)).window.document;
  assert.match(legacy.querySelectorAll(".qb-check-breakdowns section")[1].textContent, /Active features/);
});

test("party damage is applied once, capped at one HP and disallowed after reset", async () => {
  const check = { status: "failed", checkId: "check", damage: 10, damageApplied: false, resultMessageId: "result" };
  const run = { id: "run", status: "checks-resolved", checks: { "Actor.1": check } };
  let actorUpdates = 0;
  let appliedIds = [];
  const actor = {
    uuid: "Actor.1", name: "Hero", system: { attributes: { hp: { value: 5, max: 20 } } },
    getFlag: () => appliedIds,
    update: async (updates) => {
      actorUpdates++;
      actor.system.attributes.hp.value = updates["system.attributes.hp.value"];
      appliedIds = updates["flags.test.appliedDamageIds"];
    }
  };
  const result = { flags: { test: { details: { passive: {}, passiveEntries: [], passed: false } } }, update: async () => {} };
  const context = {
    MODULE_ID: "test", damageInFlight: new Set(), game: {
      user: { isGM: true, id: "gm" }, users: { activeGM: { id: "gm" } },
      messages: { get: () => result }
    },
    currentRun: async (id) => !id || id === run.id ? { run, message: null } : null,
    actorByUuid: async () => actor, persistRun: async () => {},
    findMessageByFlag: () => null, capDamageAtOneHp: (damage, hp) => Math.min(damage, hp - 1),
    renderParticipantResult: () => "", mainApplication: null,
    ui: { notifications: { info() {} } }
  };
  vm.createContext(context);
  vm.runInContext(`${part("async function applyPartyDamage(", "\nfunction bindChatActions(")}\nthis.apply = applyPartyDamage; this.legacy = applyDamage;`, context);
  await context.apply("Actor.1");
  assert.equal(actor.system.attributes.hp.value, 1);
  assert.equal(check.damageApplied, true);
  assert.equal(actorUpdates, 1);
  await assert.rejects(() => context.apply("Actor.1"), /No unapplied damage/);
  run.status = "reset";
  await assert.rejects(() => context.legacy("run:Actor.1:check", { runId: "run", actorUuid: "Actor.1" }), /no longer available/);
  assert.equal(actorUpdates, 1);
});

test("damage recovery honors the actor's operation flag and rejects non-active GMs", async () => {
  const check = { status: "failed", checkId: "check", damage: 8, damageApplied: false, resultMessageId: "result" };
  const run = { id: "run", status: "checks-resolved", checks: { "Actor.1": check } };
  let actorUpdates = 0;
  let controlDeleted = false;
  const control = {
    flags: { test: { runId: "run", actorUuid: "Actor.1", resultMessageId: "result", damage: 8, status: "applied" } },
    update: async () => {}, delete: async () => { controlDeleted = true; }
  };
  const context = {
    MODULE_ID: "test", damageInFlight: new Set(), game: {
      user: { isGM: true, id: "other-gm" }, users: { activeGM: { id: "gm" } },
      messages: { get: () => ({ flags: { test: { details: {} } }, update: async () => {} }) }
    },
    currentRun: async () => ({ run, message: null }),
    actorByUuid: async () => ({
      uuid: "Actor.1", getFlag: () => ["run:Actor.1:check"], update: async () => { actorUpdates++; }
    }),
    persistRun: async () => {}, findMessageByFlag: () => control,
    renderParticipantResult: () => "", mainApplication: null,
    ui: { notifications: { info() {} } }
  };
  vm.createContext(context);
  vm.runInContext(`${part("async function applyPartyDamage(", "\nfunction bindChatActions(")}\nthis.apply = applyPartyDamage;`, context);
  await assert.rejects(() => context.apply("Actor.1"), /Only the active GM/);
  context.game.user.id = "gm";
  await context.apply("Actor.1");
  assert.equal(check.damageApplied, true);
  assert.equal(actorUpdates, 0);
  assert.equal(controlDeleted, true);
});

test("pending legacy damage control remains usable by the active GM", async () => {
  const check = { status: "failed", checkId: "check", damage: 2, damageApplied: false, resultMessageId: "result" };
  const run = { id: "run", status: "checks-resolved", checks: { "Actor.1": check } };
  let deleted = false;
  const control = {
    flags: { test: { runId: "run", actorUuid: "Actor.1", resultMessageId: "result", damage: 2, status: "pending" } },
    update: async () => {}, delete: async () => { deleted = true; }
  };
  const actor = {
    uuid: "Actor.1", name: "Hero", system: { attributes: { hp: { value: 10, max: 10 } } },
    getFlag: () => [], update: async (updates) => { actor.system.attributes.hp.value = updates["system.attributes.hp.value"]; }
  };
  const context = {
    MODULE_ID: "test", damageInFlight: new Set(), game: {
      user: { isGM: true, id: "gm" }, users: { activeGM: { id: "gm" } }, messages: { get: () => null }
    },
    currentRun: async () => ({ run, message: null }),
    actorByUuid: async () => actor, persistRun: async () => {},
    findMessageByFlag: () => control, capDamageAtOneHp: (damage, hp) => Math.min(damage, hp - 1),
    mainApplication: null, ui: { notifications: { info() {} } }
  };
  vm.createContext(context);
  vm.runInContext(`${part("async function applyPartyDamage(", "\nfunction bindChatActions(")}\nthis.apply = applyDamage;`, context);
  await context.apply("run:Actor.1:check");
  assert.equal(actor.system.attributes.hp.value, 8);
  assert.equal(check.damageApplied, true);
  assert.equal(deleted, true);
});
