import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../scripts/quick-battles.js", import.meta.url), "utf8");
const part = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const context = {};
vm.createContext(context);
vm.runInContext(`
  ${part("const DEFAULT_CONFIG =", "\nlet mainApplication;")}
  ${part("function clone(", "\nfunction randomId(")}
  ${part("function numberValue(", "\nasync function nativeD20(")}
  ${part("function normalizeConfig(", "\nasync function readConfig(")}
  this.defaults = DEFAULT_CONFIG;
  this.normalize = normalizeConfig;
  this.migrate = bandWithDamage;
  this.withoutHp = passiveWithoutHp;
`, context);
const plain = (value) => JSON.parse(JSON.stringify(value));

test("new difficulty defaults include exact damage values and survival settings", () => {
  const config = context.normalize({});
  assert.deepEqual(plain(config.encounterDifficultyBands), [
    { min: 1, max: 7, label: "Easy", dc: 19, damage: 4 },
    { min: 8, max: 16, label: "Medium", dc: 23, damage: 6 },
    { min: 17, max: 18, label: "Hard", dc: 28, damage: 8 },
    { min: 19, max: 19, label: "Deadly", dc: 34, damage: 10 },
    { min: 20, max: 20, label: "Combat!", dc: 0, damage: 0, combat: true }
  ]);
  assert.equal(config.keepOneHp, true);
  assert.equal(config.damageCap, 1);
  assert.equal(config.maxActiveUses, 6);
  assert.equal(context.normalize({ maxActiveUses: 5 }).maxActiveUses, 5);
  assert.equal(context.normalize({ maxActiveUses: 0 }).maxActiveUses, 0);
});

test("legacy bands retain custom fields and migrate missing damage without changing configuration", () => {
  const bands = [
    { min: 1, max: 7, label: "Easy", dc: 19, metadata: "kept" },
    { min: 8, max: 16, label: "Medium", dc: 23 },
    { min: 17, max: 18, label: "Hard", dc: 29 },
    { min: 19, max: 19, label: "Deadly", dc: 34, damage: 0 },
    { min: 20, max: 20, label: "Combat", dc: 0, combat: true }
  ];
  const before = plain(bands);
  const config = context.normalize({ encounterDifficultyBands: bands, damageCap: 0.35 });
  assert.deepEqual(plain(bands), before);
  assert.deepEqual(Array.from(config.encounterDifficultyBands, (band) => band.damage), [4, 6, 6, 0, 0]);
  assert.equal(config.encounterDifficultyBands[0].metadata, "kept");
  assert.equal(config.encounterDifficultyBands[2].dc, 29);
  assert.equal(config.encounterDifficultyBands[4].label, "Combat");
  assert.equal(config.damageCap, 0.35);
  assert.equal(config.keepOneHp, true);
  assert.throws(() => context.normalize({ encounterDifficultyBands: [{ min: 1, max: 20, dc: 10, damage: -1 }] }), /non-negative whole-number damage/);
});

test("persisted participant previews lose only their legacy HP bonus", () => {
  assert.deepEqual(plain(context.withoutHp({ ability: 3, hp: 2, armor: -1, catalog: 4, total: 8 })),
    { ability: 3, armor: -1, catalog: 4, total: 6 });
  assert.deepEqual(plain(context.withoutHp({ ability: 3, total: 3 })), { ability: 3, total: 3 });
});
