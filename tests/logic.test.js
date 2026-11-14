import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  averageRoundedDown,
  availableSpellSlots,
  calculatePassiveBonuses,
  chatMessageAuthorId,
  d20ModifierParts,
  encounterBand,
  failureDamage,
  isRunActive,
  itemUses,
  mergeCatalog,
  parseFeatCatalog,
  resourceBonus,
  selectedCatalogBonuses,
  spellSlotBonus,
  submittedRollTotal
} from "../scripts/logic.js";

const catalogText = await readFile(new URL("../data/feat-catalog.csv", import.meta.url), "utf8");
const [applicationSource, configurationTemplate, mainTemplate] = await Promise.all([
  readFile(new URL("../scripts/quick-battles.js", import.meta.url), "utf8"),
  readFile(new URL("../templates/configuration.hbs", import.meta.url), "utf8"),
  readFile(new URL("../templates/quick-battles.hbs", import.meta.url), "utf8")
]);

test("Foundry V14 application implements the Handlebars rendering contract", () => {
  assert.match(
    applicationSource,
    /class QuickBattlesApplication extends foundry\.applications\.api\.HandlebarsApplicationMixin\(\s*foundry\.applications\.api\.ApplicationV2\s*\)/
  );
  assert.match(applicationSource, /mainApplication\.render\(\{ force: true \}\)/);
  assert.match(applicationSource, /application\.render\(\{ force: true \}\)/);
});

test("configuration is available through a structured Foundry settings menu", () => {
  assert.match(applicationSource, /game\.settings\.registerMenu\(MODULE_ID, "configurationMenu"/);
  assert.match(applicationSource, /game\.settings\.register\(MODULE_ID, "configuration", \{[\s\S]*?scope: "world"/);
  assert.match(configurationTemplate, /data-field="userId"/);
  assert.match(configurationTemplate, /data-field="actorUuid"/);
  assert.match(configurationTemplate, /data-config-collection="encounters"/);
  assert.match(configurationTemplate, /data-field="fateDcEasy"/);
  assert.match(configurationTemplate, /data-config-collection="catalogOverrides"/);
  assert.match(applicationSource, /actor\.testUserPermission\(user, "OWNER"\)/);
  assert.match(applicationSource, /if \(!user\.isGM && actor\.type !== "character"\)/);
  assert.match(configurationTemplate, /data-field="id" type="hidden"/);
  assert.doesNotMatch(configurationTemplate, /<span>Group ID<\/span>/);
  assert.doesNotMatch(mainTemplate, /class="qb-config"/);
});

test("Quick Battles remembers selections without duplicate main-window configuration", () => {
  assert.match(applicationSource, /scope: "client"[\s\S]*?type: Object/);
  assert.match(applicationSource, /rememberSelection\(\{ area \}\)/);
  assert.match(applicationSource, /rememberSelection\(\{ encounterGroupId: groupId \}\)/);
  assert.doesNotMatch(mainTemplate, /class="qb-toolbar"/);
  assert.doesNotMatch(mainTemplate, /<h2>Configuration<\/h2>/);
  assert.match(mainTemplate, /name="area"[\s\S]*?{{#if selected}}selected{{\/if}}/);
  assert.match(mainTemplate, /name="encounter-group"[\s\S]*?{{#if selected}}selected{{\/if}}/);
});

test("run recovery is persisted without creating a GM-only run chat card", () => {
  assert.match(applicationSource, /game\.settings\.register\(MODULE_ID, "activeRun", \{[\s\S]*?scope: "world"/);
  assert.match(applicationSource, /game\.settings\.set\(MODULE_ID, "activeRun", JSON\.stringify\(run\)\)/);
  assert.doesNotMatch(applicationSource, /content: `<p>Quick Battles run \$\{escapeHtml\(run\.id\)\}<\/p>`/);
});

test("native D20 roll configurations initialize the D&D 5e roll options", () => {
  assert.match(applicationSource, /rolls: \[\{ parts: d20ModifierParts\(modifier\),[\s\S]*?options: \{\}/);
  assert.deepEqual(d20ModifierParts(0), []);
  assert.deepEqual(d20ModifierParts(3), ["3"]);
  assert.deepEqual(d20ModifierParts(-2), ["-2"]);
});

test("submitted chat rolls deserialize Foundry v14 roll data before reading totals", () => {
  const serializedRoll = JSON.stringify({ total: 8 });
  assert.equal(submittedRollTotal(serializedRoll, JSON.parse), 8);
  assert.equal(submittedRollTotal({ total: 14 }), 14);
  assert.throws(() => submittedRollTotal(null, JSON.parse), /no valid Foundry roll/);
  assert.match(applicationSource, /submittedRollTotal\(message\.rolls\?\.\[0\], \(serialized\) => Roll\.fromJSON\(serialized\)\)/);
});

test("configuration supports GM-owned NPC mappings, searchable actors, and closes after saving", () => {
  assert.match(applicationSource, /function playerActorOptions\(user\) \{\s*if \(user\.isGM\) return sortActors\(\)/);
  assert.match(applicationSource, /if \(!user\.isGM && actor\.type !== "character"\)/);
  assert.equal((configurationTemplate.match(/data-actor-search/g) ?? []).length, 2);
  assert.equal((configurationTemplate.match(/data-actor-selector/g) ?? []).length, 2);
  assert.match(applicationSource, /return this\.close\(\)/);
  assert.doesNotMatch(mainTemplate, /data-app-action="open-config"/);
});

test("runs can be cancelled and native roll submissions recover from processing state", () => {
  assert.match(mainTemplate, /data-app-action="cancel-run"/);
  assert.match(applicationSource, /current\.run\.status = "cancelled"/);
  assert.match(applicationSource, /current\.run\.status = "fate-resolving"/);
  assert.match(applicationSource, /current\.run\.fate\.submissionId !== message\.id/);
  assert.match(applicationSource, /check\.status = "processing"/);
  assert.match(applicationSource, /game\.users\.activeGM/);
  assert.match(applicationSource, /function enqueueSubmission\(operation\)/);
});

test("the GM window shows either a new Fate check or an active run", () => {
  assert.equal(isRunActive(null), false);
  assert.equal(isRunActive({ status: "fate-pending" }), true);
  assert.equal(isRunActive({ status: "checks-pending" }), true);
  assert.equal(isRunActive({ status: "encounter-selected" }), true);
  assert.equal(isRunActive({ status: "fate-resolved", fateResult: { failed: true } }), true);
  assert.equal(isRunActive({ status: "fate-resolved", fateResult: { failed: false } }), false);
  assert.equal(isRunActive({ status: "checks-resolved" }), false);
  assert.equal(isRunActive({ status: "cancelled" }), false);
  assert.match(mainTemplate, /{{#if showCurrentRun}}[\s\S]*Current run[\s\S]*{{else}}[\s\S]*Fate check[\s\S]*{{\/if}}/);
  assert.match(applicationSource, /showCurrentRun: isRunActive\(run\)/);
});

test("participant checks close recovery after submission and restrict damage to the active GM", () => {
  assert.match(applicationSource, /findParticipantSubmission\(checkId\)/);
  assert.match(applicationSource, /removeOpenCheckButton\(checkId\)/);
  assert.match(applicationSource, /async function processParticipantSubmission\(message, data\) \{\s*const userId = chatMessageAuthorId\(message\);/);
  assert.match(applicationSource, /Only the active GM can apply damage/);
  assert.match(applicationSource, /appliedDamageIds/);
  assert.match(applicationSource, /check\.damageApplied = true/);
  assert.match(applicationSource, /Hooks\.on\("renderChatMessage", hideSubmittedCheckAction\)/);
  assert.match(applicationSource, /if \(prompt\) await prompt\.delete\(\)/);
  assert.match(applicationSource, /await control\.delete\(\)/);
  assert.match(mainTemplate, /class="qb-main-layout"/);
  assert.match(mainTemplate, /class="qb-participant-section"/);
  assert.match(mainTemplate, /qb-stage-threat/);
});

test("Fate result shows Watch Shift only for camp", () => {
  assert.match(applicationSource, /result\.situation === "camp" && result\.watchShift/);
  assert.match(applicationSource, /showWatchShift: run\.fate\.situation === "camp"/);
  assert.match(mainTemplate, /state\.fateResult\.showWatchShift/);
});

test("participant bonus preview updates from resource-count input changes", () => {
  assert.match(mainTemplate, /data-active-bonus-preview role="status" aria-live="polite"/);
  assert.match(mainTemplate, /data-bonus-count data-bonus-per-use=/);
  assert.match(applicationSource, /addEventListener\("input", \(event\) => \{[\s\S]*?updateActiveBonusPreview/);
  assert.match(applicationSource, /preview\.textContent = `Active bonus:/);
});

test("the supplied feat catalog is parsed in full, including comma-containing descriptions", () => {
  const catalog = parseFeatCatalog(catalogText);
  assert.equal(catalog.length, 384);
  assert.equal(catalog[0].name, "Actor");
  assert.equal(catalog[0].bonus, 1);
  assert.equal(catalog.find((entry) => entry.name === "Alert").description, "+5 to initiative, immune to surprise while conscious, no advantage for hidden attackers");
  assert.equal(catalog.find((entry) => entry.name === "War Caster").bonus, 3);
});

test("only catalogued actor items contribute passive bonuses or selectable active uses", () => {
  const catalog = [
    { name: "Alert", type: "Passive", bonus: 3 },
    { name: "Lucky", type: "Active", bonus: 1, bonusPerUse: 1 }
  ];
  const items = [
    { id: "alert", name: "Alert", system: {} },
    { id: "lucky", name: "Lucky", system: { uses: { max: 3, value: 2 } } },
    { id: "unknown", name: "Unknown", system: {} }
  ];
  const bonuses = selectedCatalogBonuses(catalog, items);
  assert.equal(bonuses.passiveBonus, 3);
  assert.deepEqual(bonuses.passiveEntries, [{ name: "Alert", bonus: 3 }]);
  assert.equal(bonuses.activeEntries.length, 1);
  assert.equal(bonuses.activeEntries[0].available, 2);
});

test("passive bonus calculation uses first ability on ties and includes all configured components", () => {
  const passive = calculatePassiveBonuses({
    abilities: { str: { mod: 3 }, dex: { mod: 3 }, int: { mod: 1 }, wis: { mod: 0 }, cha: { mod: 3 } },
    currentHp: 99,
    ac: 22,
    catalogBonus: 4
  });
  assert.deepEqual(passive, {
    ability: 3,
    abilityName: "STR",
    charisma: 2,
    hp: 2,
    armor: 2,
    catalog: 4,
    total: 13
  });
});

test("group Stealth average rounds down", () => {
  assert.equal(averageRoundedDown([13, 14, 18]), 15);
});

test("spell slots multiply by their configured bonus", () => {
  assert.equal(spellSlotBonus({ 1: 2, 4: 1, 9: 1 }, { 1: 1, 4: 2, 9: 4 }), 8);
});

test("spell slot levels include used capacity but hide levels with no capacity", () => {
  assert.deepEqual(
    availableSpellSlots({
      spell1: { value: 0, max: 2 },
      spell2: { value: 1, max: 2 },
      spell3: { value: 0, max: 0 },
      spell4: { value: 1, override: 1 }
    }, { 1: 1, 2: 1, 4: 2 }),
    [
      { level: 1, capacity: 2, available: 0, bonus: 1 },
      { level: 2, capacity: 2, available: 1, bonus: 1 },
      { level: 4, capacity: 1, available: 1, bonus: 2 }
    ]
  );
});

test("live active resource bonus sums selected feature uses and spell slots", () => {
  assert.equal(resourceBonus([
    { count: 2, bonusPerUse: 1 },
    { count: 1, bonusPerUse: 3 }
  ]), 5);
  assert.equal(resourceBonus([{ count: "", bonusPerUse: 4 }]), 0);
});

test("chat submission author lookup prefers the Foundry author identity", () => {
  assert.equal(chatMessageAuthorId({ author: { _id: "author-id" }, user: "legacy-id" }), "author-id");
  assert.equal(chatMessageAuthorId({ author: { id: "document-id" } }), "document-id");
  assert.equal(chatMessageAuthorId({ user: { id: "user-id" } }), "user-id");
  assert.equal(chatMessageAuthorId({ user: "legacy-id" }), "legacy-id");
});

test("difficulty bands and capped failure damage use the specified thresholds", () => {
  const bands = [
    { min: 1, max: 8, label: "Easy", dc: 18 },
    { min: 9, max: 16, label: "Medium", dc: 23 },
    { min: 17, max: 18, label: "Hard", dc: 28 },
    { min: 19, max: 20, label: "Combat", dc: 28 }
  ];
  assert.equal(encounterBand(17, bands).dc, 28);
  assert.equal(encounterBand(20, bands).label, "Combat");
  assert.deepEqual(failureDamage(101, 10, 15, 1), { margin: 5, fraction: 0.25, damage: 25 });
  assert.deepEqual(failureDamage(80, 1, 100, 0.35), { margin: 99, fraction: 0.35, damage: 28 });
});

test("native use data supports current-value and legacy spent counters", () => {
  assert.deepEqual(itemUses({ system: { uses: { max: 3, value: 1 } } }), {
    available: 1,
    updatePath: "system.uses.value",
    current: 1
  });
  assert.deepEqual(itemUses({ system: { uses: { max: 3, spent: 1 } } }), {
    available: 2,
    updatePath: "system.uses.spent",
    current: 1
  });
  assert.deepEqual(itemUses({ system: { uses: { value: 2 } } }), {
    available: 2,
    updatePath: "system.uses.value",
    current: 2
  });
});

test("catalog overrides can disable defaults and add custom features", () => {
  const merged = mergeCatalog(
    [{ name: "Alert", type: "Passive", rating: "High", bonus: 3 }],
    [
      { name: "Alert", disabled: true },
      { name: "Custom Feature", type: "Active", rating: "Medium", bonusPerUse: 2 }
    ]
  );
  assert.deepEqual(merged.map((entry) => [entry.name, entry.type, entry.bonusPerUse]), [
    ["Custom Feature", "Active", 2]
  ]);
  assert.throws(() => mergeCatalog([], [{ name: "Bad Feature", type: "Passive", bonus: "high" }]), /invalid bonus/);
});
