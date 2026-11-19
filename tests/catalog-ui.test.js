import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import Handlebars from "handlebars";
import { JSDOM } from "jsdom";
import { mergeCatalog } from "../scripts/logic.js";

const source = await readFile(new URL("../scripts/quick-battles.js", import.meta.url), "utf8");
const template = Handlebars.compile(await readFile(new URL("../templates/configuration.hbs", import.meta.url), "utf8"));
const styles = await readFile(new URL("../styles/quick-battles.css", import.meta.url), "utf8");
const formReader = source.slice(source.indexOf("function readConfigurationForm("), source.indexOf("\nasync function loadCatalog("));
const application = source.slice(
  source.indexOf("class QuickBattlesConfigurationApplication"),
  source.indexOf("\nclass QuickBattlesApplication")
);
const defaults = {
  players: [], encounterGroups: [{ id: "main", name: "Main" }], encounters: [],
  catalogOverrides: [], encounterDifficultyBands: [{ min: 1, max: 20, label: "Normal", dc: 10 }],
  fateDcs: { easy: 10, medium: 13, hard: 16 }, campBonus: 3,
  paceModifiers: { fast: -2, normal: 0, slow: 2 },
  spellSlotBonuses: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i + 1, 1])),
  damageCap: 1, maxActiveUses: 5, postGmResults: true
};
const copy = (value) => JSON.parse(JSON.stringify(value));

async function harness(overrides = []) {
  const dom = new JSDOM("<!doctype html><body><div id='app'></div></body>");
  const { window } = dom;
  const errors = [];
  let saved;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new window.Event("close"));
  };
  class ApplicationV2 {
    async _onRender() {}
    async render() {
      const context = await this._prepareContext();
      this.element.innerHTML = template(context);
      await this._onRender(context, {});
    }
    async close() { this.closed = true; }
  }
  const context = {
    foundry: { applications: { api: { ApplicationV2, HandlebarsApplicationMixin: (base) => base } } },
    window, document: window.document,
    game: { user: { isGM: true }, users: [], actors: { get: () => null } },
    ui: { notifications: { info: () => {}, warn: () => {} } },
    MODULE_ID: "test", CONFIG_TEMPLATE: "test", DEFAULT_CONFIG: defaults,
    mainApplication: null,
    clone: copy, sortActors: () => [], notifyError: (error) => errors.push(error),
    writeConfig: async (config) => {
      mergeCatalog([], config.catalogOverrides);
      saved = copy(config);
      return config;
    }
  };
  vm.createContext(context);
  vm.runInContext(`${formReader}\n${application}\nthis.App = QuickBattlesConfigurationApplication;`, context);
  const app = new context.App();
  app.element = window.document.querySelector("#app");
  app.configDraft = { ...copy(defaults), catalogOverrides: copy(overrides) };
  await app.render();
  const query = (selector) => app.element.querySelector(selector);
  const click = async (selector) => {
    const button = query(selector);
    assert.ok(button, `Missing button ${selector}`);
    button.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(errors.map((error) => error.message), []);
  };
  const field = (name) => query(`[data-catalog-dialog-field="${name}"]`);
  return { app, query, click, field, getSaved: () => saved };
}

test("feature catalog settings align beneath Results and damage with a compact persistent save action", async () => {
  const ui = await harness();
  const summary = ui.query(".qb-config-summary-grid");
  assert.deepEqual(
    Array.from(summary.children, (column) => column.classList.contains("qb-config-result-column")
      ? Array.from(column.children, (section) => section.querySelector("h2").textContent)
      : [column.querySelector("h2").textContent]),
    [["Fate and travel"], ["Spell slot bonuses"], ["Results and damage", "Feature catalog changes"]]
  );
  const resultColumn = summary.children[2];
  assert.ok(resultColumn.classList.contains("qb-config-result-column"));
  assert.equal(resultColumn.children[1].classList.contains("qb-config-catalog"), true);
  const save = ui.query('[data-app-action="save-config"]');
  assert.equal(save.textContent, "Save Settings");
  assert.match(styles, /\.qb-config-summary-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /\.qb-config-result-column\s*\{\s*display:\s*grid;[^}]*gap:\s*0\.85rem;/);
  assert.match(styles, /\.qb-config-save\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*0\.65rem;[^}]*justify-self:\s*start;/);
  assert.match(styles, /\.qb-config-shell\s*\{[^}]*overflow:\s*visible;[^}]*padding-bottom:\s*4\.25rem;/);
  assert.match(styles, /@container quick-battles \(max-width: 40rem\)[\s\S]*?\.qb-config-summary-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test("adding and editing catalog features survives rerenders and settings save", async () => {
  const ui = await harness([{ name: "Existing", type: "Passive", rating: "Medium", description: "kept" }]);
  await ui.click('[data-app-action="open-catalog-manager"]');
  await ui.click('[data-app-action="add-override"]');
  assert.equal(ui.query("[data-catalog-edit-dialog]").open, true);
  assert.equal(ui.query("[data-catalog-manager-dialog]").open, false);
  await ui.click('[data-app-action="save-catalog-dialog"]');
  assert.equal(ui.query("[data-catalog-edit-dialog]").open, true);
  ui.field("name").value = "Custom Feature";
  ui.field("description").value = "Custom description";
  ui.field("type").value = "Active";
  ui.field("rating").value = "High";
  ui.field("bonusPerUse").value = "4";
  await ui.click('[data-app-action="save-catalog-dialog"]');
  assert.equal(ui.query("[data-catalog-manager-dialog]").open, true);
  await ui.click('[data-config-index="0"] [data-app-action="edit-catalog-override"]');
  assert.equal(ui.field("name").value, "Existing");
  ui.field("rating").value = "High";
  ui.field("bonus").value = "5";
  await ui.click('[data-app-action="save-catalog-dialog"]');
  await ui.click('[data-app-action="close-catalog-manager"]');
  await ui.click('[data-app-action="add-band"]');
  assert.deepEqual(Array.from(ui.app.element.querySelectorAll("[data-feature-name]"), (el) => el.textContent), [
    "Existing", "Custom Feature"
  ]);
  // Remove the blank band again so configuration validation can proceed.
  await ui.click('[data-config-collection="encounterDifficultyBands"] [data-config-row]:last-child [data-app-action="remove-row"]');
  await ui.click('[data-app-action="save-config"]');
  const saved = ui.getSaved();
  assert.ok(saved);
  assert.deepEqual(saved.catalogOverrides, [
    { name: "Existing", type: "Passive", rating: "High", description: "kept", bonus: 5, disabled: false },
    { name: "Custom Feature", type: "Active", rating: "High", description: "Custom description", bonusPerUse: 4, disabled: false }
  ]);
});

test("removing one catalog override preserves the remaining indexed data", async () => {
  const ui = await harness([
    { name: "First", type: "Active", rating: "Low", description: "first" },
    { name: "Second", type: "Passive", rating: "High", description: "second", bonus: 7, customMetadata: "preserved" }
  ]);
  await ui.click('[data-app-action="open-catalog-manager"]');
  await ui.click('[data-config-index="0"] [data-app-action="remove-row"]');
  await ui.click('[data-config-index="0"] [data-app-action="edit-catalog-override"]');
  assert.equal(ui.field("name").value, "Second");
  assert.equal(ui.field("description").value, "second");
  assert.equal(ui.field("bonus").value, "7");
  await ui.click('[data-app-action="cancel-catalog-dialog"]');
  await ui.click('[data-app-action="close-catalog-manager"]');
  await ui.click('[data-app-action="save-config"]');
  assert.deepEqual(ui.getSaved().catalogOverrides, [
    { name: "Second", type: "Passive", rating: "High", description: "second", bonus: 7, customMetadata: "preserved", disabled: false }
  ]);
});

test("closing a new feature discards the blank row without affecting existing overrides", async () => {
  for (const [overrides, closeWithButton] of [[[], true], [[{ name: "Existing", type: "Passive", rating: "Low" }], false]]) {
    const ui = await harness(overrides);
    await ui.click('[data-app-action="open-catalog-manager"]');
    await ui.click('[data-app-action="add-override"]');
    ui.field("name").value = "Discarded";
    if (closeWithButton) await ui.click('[data-app-action="cancel-catalog-dialog"]');
    else ui.query("[data-catalog-edit-dialog]").close();
    assert.equal(ui.query("[data-catalog-manager-dialog]").open, true);
    assert.equal(ui.app.element.querySelectorAll('[data-config-collection="catalogOverrides"] [data-config-row]').length, overrides.length);
    assert.equal(Boolean(ui.query("[data-catalog-empty]")), overrides.length === 0);
    await ui.click('[data-app-action="close-catalog-manager"]');
    await ui.click('[data-app-action="save-config"]');
    assert.deepEqual(ui.getSaved().catalogOverrides.map((entry) => entry.name), overrides.map((entry) => entry.name));
  }
});
