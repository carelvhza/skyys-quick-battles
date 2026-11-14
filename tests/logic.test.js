import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  averageRoundedDown,
  calculatePassiveBonuses,
  encounterBand,
  failureDamage,
  itemUses,
  mergeCatalog,
  parseFeatCatalog,
  selectedCatalogBonuses,
  spellSlotBonus
} from "../scripts/logic.js";

const catalogText = await readFile(new URL("../data/feat-catalog.csv", import.meta.url), "utf8");

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
