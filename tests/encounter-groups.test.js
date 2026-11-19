import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../scripts/quick-battles.js", import.meta.url), "utf8");
const template = await readFile(new URL("../templates/configuration.hbs", import.meta.url), "utf8");
const styles = await readFile(new URL("../styles/quick-battles.css", import.meta.url), "utf8");
const formReader = source.slice(source.indexOf("function readConfigurationForm("), source.indexOf("\nasync function loadCatalog("));
const application = source.slice(
  source.indexOf("class QuickBattlesConfigurationApplication"),
  source.indexOf("\nclass QuickBattlesApplication")
);

function harness() {
  const warnings = [];
  let nextId = 0;
  const context = {
    foundry: {
      applications: { api: { ApplicationV2: class { async _onRender() {} }, HandlebarsApplicationMixin: (base) => base } },
      utils: { randomID: () => `new-${++nextId}` }
    },
    window: { innerWidth: 1000 },
    game: { user: { isGM: true }, users: [], actors: { get: () => null } },
    ui: { notifications: { warn: (message) => warnings.push(message), info: () => {} } },
    MODULE_ID: "test",
    CONFIG_TEMPLATE: "test",
    DEFAULT_CONFIG: {},
    clone: (value) => JSON.parse(JSON.stringify(value)),
    randomId: () => `new-${++nextId}`,
    sortActors: () => [],
    reassignEncounterGroup: (encounters, oldId, newId) => encounters.map((entry) => ({
      ...entry,
      groups: [...new Set(entry.groups.map((id) => id === oldId ? newId : id))]
    }))
  };
  vm.createContext(context);
  vm.runInContext(`${formReader}\n${application}\nthis.App = QuickBattlesConfigurationApplication; this.readForm = readConfigurationForm;`, context);
  return { app: new context.App(), readForm: context.readForm, warnings };
}

function encounterRow(id, name, groups, assigned) {
  const fields = { id: { value: id }, name: { value: name } };
  const checks = groups.map((group) => {
    const label = { querySelector: () => ({ textContent: group.name }) };
    return {
      value: group.id,
      checked: assigned.includes(group.id),
      closest: () => label
    };
  });
  return {
    dataset: { encounterId: id },
    hidden: false,
    checks,
    querySelector(selector) {
      if (selector === '[data-field="groups"]:checked') return checks.find((check) => check.checked);
      if (selector === "[data-group-summary]") return { textContent: "" };
      return fields[selector.match(/^\[data-field="(.+)"\]$/)?.[1]] ?? null;
    },
    querySelectorAll(selector) {
      return selector.includes(":checked") ? checks.filter((check) => check.checked) : checks;
    }
  };
}

function makeForm(groups, encounters) {
  const groupRows = groups.map((group) => ({
    querySelector: (selector) => ({ value: selector.includes('"id"') ? group.id : group.name })
  }));
  const encounterRows = encounters.map((entry) => encounterRow(entry.id, entry.name, groups, entry.groups));
  const options = groups.map((group) => ({ value: group.id, textContent: group.name }));
  const filter = { value: groups[0].id };
  const collections = { players: [], encounterGroups: groupRows, encounters: encounterRows, encounterDifficultyBands: [], catalogOverrides: [] };
  const listeners = {};
  const root = {
    dataset: {},
    addEventListener: (type, listener) => { listeners[type] = listener; },
    querySelector(selector) {
      if (selector === ".qb-configuration-form") return root;
      if (selector === "[data-encounter-group-filter]") return filter;
      if (selector === ":invalid") return null;
      if (selector.startsWith('[data-field="')) return { value: "0", checked: false };
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-encounter-group-filter] option") return options;
      const collection = selector.match(/^\[data-config-collection="(.+)"\] \[data-config-row\]$/)?.[1];
      return collections[collection] ?? [];
    }
  };
  return { root, groupRows, encounterRows, options, filter, listeners };
}

const groups = [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }];
const encounters = [
  { id: "shared", name: "Shared", groups: ["a", "b"], description: "kept", roster: [{ name: "Wolf", count: 2 }], dc: 17 },
  { id: "only-a", name: "Only A", groups: ["a"] },
  { id: "only-b", name: "Only B", groups: ["b"] }
];

test("group switching filters shared rows without losing unsaved or hidden encounter data", async () => {
  const { app, readForm } = harness();
  const form = makeForm(groups, encounters);
  app.element = form.root;
  app.configDraft = { encounters, catalogOverrides: [] };
  app.selectedEncounterGroupId = "a";
  app._filterEncounterRows();
  assert.deepEqual(form.encounterRows.map((row) => row.hidden), [false, false, true]);

  form.encounterRows[0].querySelector('[data-field="name"]').value = "Edited shared";
  app.selectedEncounterGroupId = "b";
  form.filter.value = "b";
  app._filterEncounterRows();
  assert.deepEqual(form.encounterRows.map((row) => row.hidden), [false, true, false]);
  const saved = readForm(form.root, app.configDraft);
  assert.equal(saved.encounters.length, 3);
  assert.equal(saved.encounters[0].name, "Edited shared");
  assert.deepEqual(JSON.parse(JSON.stringify(saved.encounters[0])), { ...encounters[0], name: "Edited shared" });
  assert.equal(saved.encounters[1].name, "Only A");

  app._rerenderConfiguration = async () => {};
  app._selectedConfigurationTab = () => "encounters";
  await app._handleConfigurationAction({ dataset: { appAction: "add-encounter" } });
  assert.deepEqual(JSON.parse(JSON.stringify(app.configDraft.encounters.at(-1).groups)), ["b"]);
});

test("filter options follow group renames and removed selection falls back to remaining group", async () => {
  const { app } = harness();
  const form = makeForm(groups, encounters);
  app.element = form.root;
  app.selectedEncounterGroupId = "b";
  form.groupRows[1].querySelector = (selector) => ({ value: selector.includes('"id"') ? "b" : "Renamed" });
  app._updateGroupSummaries();
  assert.equal(form.options[1].textContent, "Renamed");
  app.configDraft = {
    players: [], encounterGroups: [groups[0]], encounters: [encounters[1]],
    encounterDifficultyBands: [], catalogOverrides: [], spellSlotBonuses: {}
  };
  const context = await app._prepareContext();
  assert.equal(app.selectedEncounterGroupId, "a");
  assert.deepEqual(JSON.parse(JSON.stringify(context.encounterGroupFilterOptions)), [{ ...groups[0], selected: true }]);
});

test("adding a group updates filter options without changing the selected group", async () => {
  const { app } = harness();
  const form = makeForm(groups, encounters);
  app.element = form.root;
  app.configDraft = { encounters, catalogOverrides: [] };
  app.selectedEncounterGroupId = "b";
  app._selectedConfigurationTab = () => "groups";
  app._rerenderConfiguration = async () => {};
  await app._handleConfigurationAction({ dataset: { appAction: "add-group" } });
  const context = await app._prepareContext();
  assert.deepEqual(Array.from(context.encounterGroupFilterOptions, (option) => [option.id, option.selected]), [
    ["a", false], ["b", true], ["new-1", false]
  ]);
});

test("removing a shared encounter removes its single record, including in other groups", async () => {
  const { app } = harness();
  const form = makeForm(groups, encounters);
  app.element = form.root;
  app.configDraft = { encounters, catalogOverrides: [] };
  app.selectedEncounterGroupId = "a";
  app._selectedConfigurationTab = () => "encounters";
  app._rerenderConfiguration = async () => {};
  const row = form.encounterRows[0];
  row.closest = () => null;
  row.remove = () => form.encounterRows.splice(form.encounterRows.indexOf(row), 1);
  await app._handleConfigurationAction({ dataset: { appAction: "remove-row" }, closest: () => row });
  assert.deepEqual(Array.from(app.configDraft.encounters, (entry) => entry.id), ["only-a", "only-b"]);
});

test("change events switch groups and prevent an encounter from losing its last assignment", async () => {
  const { app, warnings } = harness();
  const form = makeForm(groups, encounters);
  app.element = form.root;
  app.selectedEncounterGroupId = "a";
  await app._onRender({}, {});
  const selector = {
    value: "b",
    matches: (query) => query === "[data-encounter-group-filter]"
  };
  form.listeners.change({ target: selector });
  assert.equal(app.selectedEncounterGroupId, "b");
  assert.deepEqual(form.encounterRows.map((row) => row.hidden), [false, true, false]);

  const row = form.encounterRows[2];
  const check = row.checks[1];
  check.checked = false;
  check.matches = (query) => query === '[data-field="groups"]';
  const closest = check.closest;
  check.closest = (selector) => selector === "[data-config-row]" ? row : closest(selector);
  form.listeners.change({ target: check });
  assert.equal(check.checked, true);
  assert.equal(warnings.length, 1);
});

test("deleting the selected group reassigns hidden encounters and picks the remaining group", async () => {
  const { app } = harness();
  const form = makeForm(groups, encounters);
  app.element = form.root;
  app.configDraft = { encounters, catalogOverrides: [] };
  app.selectedEncounterGroupId = "b";
  app._selectedConfigurationTab = () => "groups";
  app._confirmGroupDeletion = async () => true;
  app._rerenderConfiguration = async () => {};
  await app._removeEncounterGroup({ closest: () => form.groupRows[1] });
  assert.deepEqual(Array.from(app.configDraft.encounters, (entry) => [entry.id, Array.from(entry.groups)]), [
    ["shared", ["a"]], ["only-a", ["a"]], ["only-b", ["a"]]
  ]);
  assert.deepEqual(Array.from(app.configDraft.encounterGroups, (group) => group.id), ["a"]);
  const context = await app._prepareContext();
  assert.equal(app.selectedEncounterGroupId, "a");
  assert.deepEqual(Array.from(context.encounterGroupFilterOptions, (option) => option.id), ["a"]);
});

test("saving reveals an invalid encounter hidden in a different group", async () => {
  const { app } = harness();
  const form = makeForm(groups, encounters);
  app.element = form.root;
  app.selectedEncounterGroupId = "a";
  app._filterEncounterRows();
  const row = form.encounterRows[2];
  let reported = false;
  let selectedTab;
  const invalid = {
    closest: (selector) => selector === "[data-config-tab-panel]" ? { dataset: { configTabPanel: "encounters" } } : row,
    reportValidity: () => { reported = true; }
  };
  const querySelector = form.root.querySelector;
  form.root.querySelector = (selector) => selector === ":invalid" ? invalid : querySelector(selector);
  app._selectConfigurationTab = (tab) => { selectedTab = tab; };
  await app._handleConfigurationAction({ dataset: { appAction: "save-config" } });
  assert.equal(selectedTab, "encounters");
  assert.equal(app.selectedEncounterGroupId, "b");
  assert.equal(form.filter.value, "b");
  assert.equal(row.hidden, false);
  assert.equal(reported, true);
});

test("filter markup and hidden row styles are wired to the configuration editor", () => {
  assert.match(template, /<select data-encounter-group-filter>/);
  assert.match(template, /each encounterGroupFilterOptions/);
  assert.match(styles, /\.qb-config-rows \.qb-encounter-config-row\[hidden\]\s*\{\s*display: none/);
  assert.match(source, /field\.matches\("\[data-encounter-group-filter\]"\)/);
});
