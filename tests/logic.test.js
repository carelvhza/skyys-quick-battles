import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  activeUseCount,
  applyResourceUpdates,
  averageRoundedDown,
  availableSpellSlots,
  calculatePassiveBonuses,
  capDamageAtOneHp,
  chatMessageAuthorId,
  d20ModifierParts,
  encounterBand,
  failureDamage,
  isRunActive,
  itemUses,
  mergeCatalog,
  parseFeatCatalog,
  resourceBonus,
  reassignEncounterGroup,
  selectedCatalogBonuses,
  spellSlotBonus,
  spellSlotSpendPlan,
  submittedRollTotal,
  validateActiveUseLimit
} from "../scripts/logic.js";

const catalogText = await readFile(new URL("../data/feat-catalog.csv", import.meta.url), "utf8");
const [applicationSource, configurationTemplate, mainTemplate, styleSource] = await Promise.all([
  readFile(new URL("../scripts/quick-battles.js", import.meta.url), "utf8"),
  readFile(new URL("../templates/configuration.hbs", import.meta.url), "utf8"),
  readFile(new URL("../templates/quick-battles.hbs", import.meta.url), "utf8"),
  readFile(new URL("../styles/quick-battles.css", import.meta.url), "utf8")
]);

test("Foundry V14 application implements the Handlebars rendering contract", () => {
  assert.match(
    applicationSource,
    /class QuickBattlesApplication extends foundry\.applications\.api\.HandlebarsApplicationMixin\(\s*foundry\.applications\.api\.ApplicationV2\s*\)/
  );
  assert.match(applicationSource, /mainApplication\.render\(\{ force: true \}\)/);
  assert.match(applicationSource, /application\.render\(\{ force: true \}\)/);
});

test("Quick Battle chat commands use Foundry V14's ChatLog command registry", () => {
  assert.match(applicationSource, /const QUICK_BATTLE_CHAT_COMMANDS = \["quickbattle", "quickbattles"\]/);
  assert.match(applicationSource, /const commands = ui\.chat\?\.constructor\?\.CHAT_COMMANDS/);
  assert.ok(applicationSource.includes('rgx: new RegExp(`^\\\\/${command}\\\\s*$`, "i")'));
  assert.match(applicationSource, /fn: openQuickBattles/);
  assert.match(applicationSource, /function openQuickBattles\(\) \{\s*if \(!game\.user\.isGM\)/);
  assert.match(applicationSource, /registerQuickBattleChatCommands\(\);/);
  assert.doesNotMatch(applicationSource, /Hooks\.on\("chatMessage"/);
  for (const command of ["quickbattle", "quickbattles"]) {
    const pattern = new RegExp(`^\\/${command}\\s*$`, "i");
    assert.equal(pattern.test(`/${command}`), true);
    assert.equal(pattern.test(`/${command.toUpperCase()} `), true);
  }
});

test("Quick Battle is a GM-only Token Controls button for the shared application action", () => {
  assert.match(applicationSource, /Hooks\.on\("getSceneControlButtons", addQuickBattleTokenControl\)/);
  assert.match(applicationSource, /function addQuickBattleTokenControl\(controls\) \{\s*const tokenControl = controls\.tokens;/);
  assert.match(applicationSource, /tokenControl\.tools\.quickbattles = \{[\s\S]*?icon: "fa-solid fa-swords"[\s\S]*?button: true,[\s\S]*?visible: game\.user\.isGM,[\s\S]*?if \(active\) openQuickBattles\(\);/);
});

test("configuration is available through a structured Foundry settings menu", () => {
  assert.match(applicationSource, /game\.settings\.registerMenu\(MODULE_ID, "configurationMenu"/);
  assert.match(applicationSource, /game\.settings\.register\(MODULE_ID, "configuration", \{[\s\S]*?scope: "world"/);
  assert.match(configurationTemplate, /data-field="userId"/);
  assert.match(configurationTemplate, /data-field="actorUuid"/);
  assert.match(configurationTemplate, /data-config-collection="encounters"/);
  assert.match(configurationTemplate, /data-field="fateDcEasy"/);
  assert.match(configurationTemplate, /Maximum number of active feats or spells that can be used[\s\S]*data-field="maxActiveUses"/);
  assert.match(configurationTemplate, /data-config-collection="catalogOverrides"/);
  assert.match(applicationSource, /const width = Math\.min\([\s\S]*?viewportWidth \* 0\.7/);
  assert.match(styleSource, /\.qb-config-summary-grid\s*\{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styleSource, /@container quick-battles \(max-width: 40rem\)[\s\S]*\.qb-config-summary-grid/);
  assert.match(styleSource, /\.qb-section\s*\{\s*border-color: color-mix/);
  assert.match(configurationTemplate, /qb-config-shell/);
  assert.match(applicationSource, /actor\.testUserPermission\(user, "OWNER"\)/);
  assert.match(applicationSource, /if \(!user\.isGM && actor\.type !== "character"\)/);
  assert.match(configurationTemplate, /data-field="id" type="hidden"/);
  assert.doesNotMatch(configurationTemplate, /<span>Group ID<\/span>/);
  assert.doesNotMatch(mainTemplate, /class="qb-config"/);
});

test("configuration sections use the requested order and encounter details open in an accessible dialog", () => {
  const sections = [
    "Participating Player Actors",
    "Encounter groups",
    "Encounters",
    "Encounter difficulty bands",
    "Fate and travel",
    "Spell slot bonuses",
    "Results and damage",
    "Feature catalog changes"
  ];
  const positions = sections.map((title) => configurationTemplate.indexOf(`<h2>${title}</h2>`));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  assert.match(configurationTemplate, /class="qb-config-top-grid"[\s\S]*Participating Player Actors[\s\S]*role="tablist"[\s\S]*data-config-tab-panel="groups"[\s\S]*data-config-tab-panel="encounters"[\s\S]*data-config-tab-panel="difficulty"/);
  assert.match(configurationTemplate, /class="qb-config-summary-grid"[\s\S]*Fate and travel[\s\S]*Spell slot bonuses[\s\S]*Results and damage/);
  assert.match(configurationTemplate, /data-app-action="open-catalog-manager"/);
  assert.match(configurationTemplate, /data-catalog-manager-dialog/);
  assert.match(configurationTemplate, /data-catalog-edit-dialog/);
  assert.match(configurationTemplate, /data-feature-name/);
  assert.match(configurationTemplate, /data-feature-type/);
  assert.match(configurationTemplate, /data-feature-rating/);
  assert.match(configurationTemplate, /data-app-action="edit-catalog-override"/);
  assert.match(configurationTemplate, /data-catalog-dialog-field="description"/);
  assert.match(configurationTemplate, /data-catalog-dialog-field="bonusPerUse"/);
  assert.match(configurationTemplate, /data-catalog-dialog-field="disabled"/);
  assert.match(configurationTemplate, /<dialog[^>]*data-encounter-dialog[^>]*aria-labelledby=/);
  assert.match(configurationTemplate, /data-dialog-field="description"/);
  assert.match(configurationTemplate, /data-dialog-field="difficultyLabel"/);
  assert.match(configurationTemplate, /data-dialog-field="dc"/);
  assert.match(configurationTemplate, /data-dialog-roster/);
  assert.match(configurationTemplate, /data-group-summary/);
  assert.match(configurationTemplate, /data-field="description" type="hidden"/);
  assert.match(configurationTemplate, /data-field="combat" type="checkbox"/);
  assert.doesNotMatch(configurationTemplate, /type="text" data-field="(?:min|max|dc|combat)"/);
  assert.match(applicationSource, /baseConfig\.catalogOverrides\[index\]/);
  assert.match(applicationSource, /dialog\.showModal\(\)/);
  assert.match(applicationSource, /_selectConfigurationTab\(tab\)/);
  assert.match(applicationSource, /activeCatalogIndex/);
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

test("older saved configurations inherit the new active-use default", () => {
  assert.match(applicationSource, /maxActiveUses: 5/);
  assert.match(applicationSource, /const config = \{\s*\.\.\.clone\(DEFAULT_CONFIG\),\s*\.\.\.candidate/);
  assert.match(applicationSource, /maxActiveUses: payload\.config\?\.maxActiveUses \?\? 5/);
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

test("configuration filters player actor options by ownership and scrolls long actor lists", () => {
  assert.match(applicationSource, /function playerActorOptions\(user\) \{\s*if \(user\.isGM\) return sortActors\(\)/);
  assert.match(applicationSource, /\.sort\(\(left, right\) => left\.name\.localeCompare\(right\.name\)\)/);
  assert.match(applicationSource, /if \(!user\.isGM && actor\.type !== "character"\)/);
  assert.doesNotMatch(configurationTemplate, /data-actor-search/);
  assert.equal((configurationTemplate.match(/data-actor-selector/g) ?? []).length, 1);
  assert.match(applicationSource, /actorListSize: selectedActors\.length > 10 \? 10 : 1/);
  assert.match(applicationSource, /select\.size = actors\.length > 10 \? 10 : 1/);
  assert.match(applicationSource, /return this\.close\(\)/);
  assert.doesNotMatch(mainTemplate, /data-app-action="open-config"/);
});

test("empty encounter group configuration receives Main and linked groups are reassigned without mutation", () => {
  assert.match(applicationSource, /encounterGroups: \[\{ id: "main", name: "Main" \}\]/);
  assert.match(applicationSource, /if \(config\.encounterGroups\.length === 0\) config\.encounterGroups = clone\(DEFAULT_CONFIG\.encounterGroups\)/);
  const encounters = [
    { id: "a", groups: ["remove", "keep"] },
    { id: "b", groups: ["remove"] },
    { id: "c", groups: ["keep"] }
  ];
  const reassigned = reassignEncounterGroup(encounters, "remove", "main");
  assert.deepEqual(reassigned.map(({ id, groups }) => [id, groups]), [
    ["a", ["main", "keep"]],
    ["b", ["main"]],
    ["c", ["keep"]]
  ]);
  assert.deepEqual(encounters[0].groups, ["remove", "keep"]);
  assert.throws(() => reassignEncounterGroup(encounters, "remove", ""), /remaining encounter group/);
  assert.match(applicationSource, /if \(draft\.encounterGroups\.length <= 1\)/);
  assert.match(applicationSource, /if \(!confirmed\) return/);
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
  assert.match(applicationSource, /capDamageAtOneHp\(payload\.damage, currentHp\)/);
  assert.match(applicationSource, /Hooks\.on\("renderChatMessage", hideSubmittedCheckAction\)/);
  assert.match(applicationSource, /if \(prompt\) await prompt\.delete\(\)/);
  assert.match(applicationSource, /await control\.delete\(\)/);
  assert.match(mainTemplate, /class="qb-main-layout(?:\s|")/);
  assert.match(mainTemplate, /{{#if showCurrentRun}}[\s\S]*class="qb-secondary-column"[\s\S]*{{\/if}}/);
  assert.match(mainTemplate, /qb-main-layout-no-opposition/);
  assert.match(mainTemplate, /class="qb-participant-section"/);
  assert.match(mainTemplate, /qb-stage-threat/);
  assert.match(applicationSource, /qb-encounter-difficulty/);
  assert.doesNotMatch(applicationSource, /Resources spent:/);
});

test("Fate result shows Watch Shift only for camp", () => {
  assert.match(applicationSource, /result\.situation === "camp" && result\.watchShift/);
  assert.match(applicationSource, /showWatchShift: run\.fate\.situation === "camp"/);
  assert.match(mainTemplate, /state\.fateResult\.showWatchShift/);
});

test("participant bonus preview updates from resource-count input changes", () => {
  assert.match(mainTemplate, /data-active-bonus-preview[^>]*role="status" aria-live="polite"[\s\S]*data-bonus-total/);
  assert.match(mainTemplate, /data-bonus-count data-bonus-per-use=/);
  assert.match(applicationSource, /addEventListener\("input", \(event\) => \{[\s\S]*?updateActiveBonusPreview/);
  assert.match(applicationSource, /preview\.querySelector\("\[data-bonus-total\]"\)\.textContent/);
  assert.match(styleSource, /\.qb-active-bonus-preview\s*\{\s*margin: 0;[\s\S]*justify-content: space-between/);
  assert.match(mainTemplate, /data-max-active-uses="\{\{maxActiveUses\}\}"[\s\S]*data-active-use-feedback/);
  assert.match(applicationSource, /maxActiveUses: config\.maxActiveUses/);
  assert.match(applicationSource, /validateActiveUseLimit\(activePlan\.count/);
});

test("the supplied feat catalog is parsed in full, including semicolon-containing descriptions", () => {
  const catalog = parseFeatCatalog(catalogText);
  assert.equal(catalog.length, 374);
  assert.equal(catalog.find((entry) => entry.name === "Actor").bonus, 1);
  assert.equal(catalog.find((entry) => entry.name === "Alert").description, "+5 to initiative; immune to surprise while conscious; no advantage for hidden attackers");
  assert.equal(catalog.find((entry) => entry.name === "War Caster").bonus, 3);
});

test("only catalogued actor items contribute passive bonuses or selectable active uses", () => {
  const catalog = [
    { name: "Alert", type: "Passive", bonus: 3 },
    { name: "Lucky", type: "Active", bonus: 1, bonusPerUse: 1 },
    { name: "Lay on Hands", type: "Active", bonus: 2, bonusPerUse: 2 }
  ];
  const items = [
    { id: "alert", name: "Alert", system: {} },
    { id: "lucky", name: "Lucky", system: { uses: { max: 3, value: 2 } } },
    { id: "lay-on-hands", name: "Lay on Hands", system: { uses: { max: 60, value: 60 } } },
    { id: "unknown", name: "Unknown", system: {} }
  ];
  const bonuses = selectedCatalogBonuses(catalog, items);
  assert.equal(bonuses.passiveBonus, 3);
  assert.deepEqual(bonuses.passiveEntries, [{ name: "Alert", bonus: 3 }]);
  assert.equal(bonuses.activeEntries.length, 2);
  assert.equal(bonuses.activeEntries[0].available, 2);
  assert.deepEqual(
    (({ name, bonusPerUse, available, resourceCostPerUse, resourceAvailable }) => (
      { name, bonusPerUse, available, resourceCostPerUse, resourceAvailable }
    ))(bonuses.activeEntries[1]),
    {
      name: "Lay on Hands",
      bonusPerUse: 1,
      available: 3,
      resourceCostPerUse: 20,
      resourceAvailable: 60
    }
  );
  assert.equal(resourceBonus([{ count: 3, bonusPerUse: bonuses.activeEntries[1].bonusPerUse }]), 3);
  assert.match(mainTemplate, /resourceAvailable\}\}\/\{\{resourceCostPerUse/);
  assert.match(applicationSource, /const resourceCount = count \* \(option\.resourceCostPerUse \?\? 1\)/);
  const partiallySpent = selectedCatalogBonuses(catalog, [
    { id: "lay-on-hands", name: "Lay on Hands", system: { uses: { max: 60, value: 59 } } }
  ]);
  assert.equal(partiallySpent.activeEntries[0].available, 2);
});

test("passive bonus calculation uses only the highest ability and other configured components", () => {
  const passive = calculatePassiveBonuses({
    abilities: { str: { mod: 3 }, dex: { mod: 3 }, int: { mod: 1 }, wis: { mod: 0 }, cha: { mod: 3 } },
    currentHp: 99,
    ac: 22,
    catalogBonus: 4
  });
  assert.deepEqual(passive, {
    ability: 3,
    abilityName: "STR",
    hp: 1,
    armor: 2,
    catalog: 4,
    total: 10
  });
});

test("current HP bonus increases by one per 50 hit points", () => {
  for (const [currentHp, expectedBonus] of [[49, 0], [50, 1], [99, 1], [100, 2]]) {
    assert.equal(calculatePassiveBonuses({ currentHp }).hp, expectedBonus);
  }
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
      {
        level: 1,
        capacity: 2,
        available: 0,
        bonus: 1,
        resources: [{ key: "spell1", capacity: 2, current: 0, available: 0 }]
      },
      {
        level: 2,
        capacity: 2,
        available: 1,
        bonus: 1,
        resources: [{ key: "spell2", capacity: 2, current: 1, available: 1 }]
      },
      {
        level: 4,
        capacity: 1,
        available: 1,
        bonus: 2,
        resources: [{ key: "spell4", capacity: 1, current: 1, available: 1 }]
      }
    ]
  );
});

test("Warlock pact slots appear at their pact level with configured bonuses, including when spent", () => {
  const slots = availableSpellSlots({
    spell2: { value: 1, max: 1 },
    pact: { value: 0, max: 2, level: 5 }
  }, { 2: 3, 5: 9 });
  assert.deepEqual(slots, [
    {
      level: 2,
      capacity: 1,
      available: 1,
      bonus: 3,
      resources: [{ key: "spell2", capacity: 1, current: 1, available: 1 }]
    },
    {
      level: 5,
      capacity: 2,
      available: 0,
      bonus: 9,
      resources: [{ key: "pact", capacity: 2, current: 0, available: 0 }]
    }
  ]);
});

test("spell-slot spending consumes ordinary and pact slots and preserves configured bonus values", async () => {
  const actor = {
    system: {
      spells: {
        spell3: { value: 1, max: 1 },
        pact: { value: 2, max: 2, level: 3 }
      }
    },
    async update(updates) {
      for (const [path, value] of Object.entries(updates)) {
        const parts = path.split(".");
        const key = parts.pop();
        parts.reduce((object, part) => object[part], this)[key] = value;
      }
    }
  };
  const plan = spellSlotSpendPlan(actor.system.spells, { 3: 2 }, { 3: 7 });

  assert.deepEqual(plan, {
    spends: { 3: 2 },
    updates: {
      "system.spells.spell3.value": 0,
      "system.spells.pact.value": 1
    },
    bonus: 14
  });
  await applyResourceUpdates(actor, [], plan.updates);
  assert.equal(actor.system.spells.spell3.value, 0);
  assert.equal(actor.system.spells.pact.value, 1);
  assert.throws(
    () => spellSlotSpendPlan(actor.system.spells, { 3: 3 }, { 3: 7 }),
    /Not enough level 3 spell slots remain/
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

test("default difficulty bands use the exact encounter thresholds", () => {
  const bands = [
    { min: 1, max: 7, label: "Easy", dc: 19 },
    { min: 8, max: 16, label: "Medium", dc: 23 },
    { min: 17, max: 18, label: "Hard", dc: 29 },
    { min: 19, max: 19, label: "Deadly", dc: 34 },
    { min: 20, max: 20, label: "Combat", dc: 0, combat: true }
  ];
  assert.deepEqual([1, 7, 8, 16, 17, 18, 19, 20].map((roll) => {
    const { min, max, label, dc } = encounterBand(roll, bands);
    return { min, max, label, dc };
  }), [
    { min: 1, max: 7, label: "Easy", dc: 19 },
    { min: 1, max: 7, label: "Easy", dc: 19 },
    { min: 8, max: 16, label: "Medium", dc: 23 },
    { min: 8, max: 16, label: "Medium", dc: 23 },
    { min: 17, max: 18, label: "Hard", dc: 29 },
    { min: 17, max: 18, label: "Hard", dc: 29 },
    { min: 19, max: 19, label: "Deadly", dc: 34 },
    { min: 20, max: 20, label: "Combat", dc: 0 }
  ]);
  assert.match(applicationSource, /\{ min: 1, max: 7, label: "Easy", dc: 19 \}[\s\S]*\{ min: 8, max: 16, label: "Medium", dc: 23 \}[\s\S]*\{ min: 17, max: 18, label: "Hard", dc: 29 \}[\s\S]*\{ min: 19, max: 19, label: "Deadly", dc: 34 \}[\s\S]*\{ min: 20, max: 20, label: "Combat", dc: 0, combat: true \}/);
});

test("the configured active feat and spell limit counts uses together", () => {
  assert.equal(activeUseCount([{ count: 2 }, { count: 1 }, { count: "" }]), 3);
  assert.equal(validateActiveUseLimit(5, 5), 5);
  assert.throws(() => validateActiveUseLimit(6, 5), /no more than 5 active feats or spells/);
  assert.throws(() => validateActiveUseLimit(0, -1), /non-negative whole number/);
});

test("capped failure damage uses the specified thresholds", () => {
  assert.deepEqual(failureDamage(101, 10, 15, 1), { margin: 5, fraction: 0.25, damage: 25 });
  assert.deepEqual(failureDamage(80, 1, 100, 0.35), { margin: 99, fraction: 0.35, damage: 28 });
});

test("failure damage is capped to leave at least one current hit point", () => {
  assert.deepEqual(failureDamage(100, 0, 100, 1, 10), { margin: 100, fraction: 0.09, damage: 9 });
  assert.deepEqual(failureDamage(100, 0, 100, 0.25, 10), { margin: 100, fraction: 0.09, damage: 9 });
  assert.deepEqual(failureDamage(100, 0, 100, 1, 1), { margin: 100, fraction: 0, damage: 0 });
  assert.deepEqual(failureDamage(100, 0, 100, 1, 0), { margin: 100, fraction: 0, damage: 0 });
  assert.deepEqual(failureDamage(100, 0, 100, 1, 50), { margin: 100, fraction: 0.49, damage: 49 });
});

test("damage application cap never raises HP and accounts for intervening damage", () => {
  assert.equal(capDamageAtOneHp(20, 10), 9);
  assert.equal(capDamageAtOneHp(20, 1), 0);
  assert.equal(capDamageAtOneHp(20, 0), 0);
  assert.equal(capDamageAtOneHp(0, 10), 0);
  assert.equal(capDamageAtOneHp(4, 10), 4);
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

test("resource updates persist D&D 5e item uses and spell-slot values", async () => {
  const item = {
    id: "feature",
    name: "Lucky",
    system: { uses: { value: 2, max: 3 } },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
        const parts = path.split(".");
        const key = parts.pop();
        const parent = parts.reduce((object, part) => object[part], this);
        parent[key] = value;
      }
    }
  };
  const actor = {
    items: new Map([[item.id, item]]),
    system: { spells: { spell1: { value: 2, max: 3 } } },
    async update(updates) {
      for (const [path, value] of Object.entries(updates)) {
        const parts = path.split(".");
        const key = parts.pop();
        const parent = parts.reduce((object, part) => object[part], this);
        parent[key] = value;
      }
    }
  };

  await applyResourceUpdates(actor, [
    { _id: "feature", "system.uses.value": 1 }
  ], {
    "system.spells.spell1.value": 1
  });
  assert.equal(item.system.uses.value, 1);
  assert.equal(actor.system.spells.spell1.value, 1);
});

test("resource update failures and unpersisted paths are surfaced", async () => {
  const permissionDeniedItem = {
    name: "Lucky",
    async update() {
      throw new Error("permission denied");
    }
  };
  await assert.rejects(
    applyResourceUpdates({
      items: new Map([["feature", permissionDeniedItem]])
    }, [{ _id: "feature", "system.uses.value": 0 }]),
    /permission denied/
  );
  await assert.rejects(
    applyResourceUpdates({
      items: new Map([["feature", {
        name: "Lucky",
        system: { uses: { value: 2 } },
        async update() {}
      }]])
    }, [{ _id: "feature", "system.uses.value": 1 }]),
    /was not saved/
  );
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
