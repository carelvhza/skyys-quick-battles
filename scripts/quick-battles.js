import {
  applyResourceUpdates,
  averageRoundedDown,
  availableSpellSlots,
  capDamageAtOneHp,
  calculatePassiveBonuses,
  chatMessageAuthorId,
  d20ModifierParts,
  encounterBand,
  failureDamage,
  isRunActive,
  itemUses,
  mergeCatalog,
  parseFeatCatalog,
  reassignEncounterGroup,
  resourceBonus,
  selectedCatalogBonuses,
  spellSlotBonus,
  submittedRollTotal
} from "./logic.js";

const MODULE_ID = "skyys-quick-battles";
const TEMPLATE = `modules/${MODULE_ID}/templates/quick-battles.hbs`;
const CONFIG_TEMPLATE = `modules/${MODULE_ID}/templates/configuration.hbs`;
const DEFAULT_LAST_SELECTION = { area: "medium", encounterGroupId: "" };
const DEFAULT_CONFIG = {
  players: [],
  encounterGroups: [{ id: "main", name: "Main" }],
  encounters: [],
  catalogOverrides: [],
  fateDcs: { easy: 10, medium: 13, hard: 16 },
  campBonus: 3,
  paceModifiers: { fast: -2, normal: 0, slow: 2 },
  spellSlotBonuses: { 1: 1, 2: 1, 3: 2, 4: 2, 5: 2, 6: 3, 7: 3, 8: 3, 9: 4 },
  encounterDifficultyBands: [
    { min: 1, max: 8, label: "Easy", dc: 18 },
    { min: 9, max: 16, label: "Medium", dc: 23 },
    { min: 17, max: 18, label: "Hard", dc: 28 },
    { min: 19, max: 20, label: "Combat", dc: 28, combat: true }
  ],
  damageCap: 1,
  postGmResults: true
};

let mainApplication;
let catalogPromise;
let activeRunMessage;
const inFlight = new Set();
const damageInFlight = new Set();
const participantApplications = new Map();
let submissionQueue = Promise.resolve();

function enqueueSubmission(operation) {
  submissionQueue = submissionQueue.then(operation).catch(notifyError);
  return submissionQueue;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function randomId() {
  return foundry.utils.randomID();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function notifyError(error) {
  console.error(`[${MODULE_ID}]`, error);
  ui.notifications.error(error instanceof Error ? error.message : String(error));
}

function gmUserIds() {
  return Array.from(game.users).filter((user) => user.isGM).map((user) => user.id);
}

function numberValue(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number.`);
  return parsed;
}

async function nativeD20(actor, modifier, flavor) {
  const rollClass = CONFIG.Dice.D20Roll;
  if (!rollClass?.build) throw new Error("D&D 5e's native D20 roll workflow is unavailable.");
  const rolls = await rollClass.build(
    {
      rolls: [{ parts: d20ModifierParts(modifier), data: actor?.getRollData?.() ?? {}, options: {} }],
      subject: actor ?? undefined,
      hookNames: ["D20Test"]
    },
    {},
    {
      create: false,
      rollMode: "gmroll",
      data: {
        flavor,
        speaker: actor ? ChatMessage.getSpeaker({ actor }) : ChatMessage.getSpeaker()
      }
    }
  );
  return rolls?.[0] ?? null;
}

function normalizeConfig(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Configuration must be a JSON object.");
  }
  const config = {
    ...clone(DEFAULT_CONFIG),
    ...candidate,
    fateDcs: { ...DEFAULT_CONFIG.fateDcs, ...(candidate.fateDcs ?? {}) },
    paceModifiers: { ...DEFAULT_CONFIG.paceModifiers, ...(candidate.paceModifiers ?? {}) },
    spellSlotBonuses: { ...DEFAULT_CONFIG.spellSlotBonuses, ...(candidate.spellSlotBonuses ?? {}) },
    encounterDifficultyBands: candidate.encounterDifficultyBands ?? clone(DEFAULT_CONFIG.encounterDifficultyBands)
  };
  for (const key of ["players", "encounterGroups", "encounters", "catalogOverrides", "encounterDifficultyBands"]) {
    if (!Array.isArray(config[key])) throw new Error(`${key} must be an array.`);
  }
  if (config.encounterGroups.length === 0) config.encounterGroups = clone(DEFAULT_CONFIG.encounterGroups);
  if (config.players.some((player) => !player?.userId || !player?.actorUuid)) {
    throw new Error("Each player entry needs a userId and actorUuid.");
  }
  if (new Set(config.players.map((player) => player.userId)).size !== config.players.length
    || new Set(config.players.map((player) => player.actorUuid)).size !== config.players.length) {
    throw new Error("Each configured player and main character must appear only once.");
  }
  for (const [label, value] of [
    ["campBonus", config.campBonus],
    ["fast pace modifier", config.paceModifiers.fast],
    ["regular pace modifier", config.paceModifiers.normal],
    ["slow pace modifier", config.paceModifiers.slow],
    ["easy Fate DC", config.fateDcs.easy],
    ["medium Fate DC", config.fateDcs.medium],
    ["hard Fate DC", config.fateDcs.hard]
  ]) {
    if (!Number.isFinite(Number(value))) throw new Error(`${label} must be a number.`);
  }
  const groupIds = new Set(config.encounterGroups.map((group) => group?.id).filter(Boolean));
  if (config.encounterGroups.some((group) => !group?.id || !group?.name)) {
    throw new Error("Each encounter group needs an id and name.");
  }
  if (config.encounters.some((entry) => !entry?.name || !Array.isArray(entry.groups) || entry.groups.length === 0)) {
    throw new Error("Each encounter needs a name and a groups array.");
  }
  if (config.encounters.some((entry) => entry.groups.some((groupId) => !groupIds.has(groupId)))) {
    throw new Error("Every encounter group reference must match a configured group id.");
  }
  if (config.encounters.some((entry) => entry.roster != null && !Array.isArray(entry.roster))) {
    throw new Error("Encounter rosters must be arrays.");
  }
  if (config.encounters.some((entry) => (entry.roster ?? []).some((member) => (
    !member || typeof member !== "object"
    || (!member.actorId && !member.actorUuid && !member.name)
    || (member.count != null && (!Number.isInteger(Number(member.count)) || Number(member.count) < 1))
  )))) {
    throw new Error("Each roster entry needs an actor id, UUID, or name and a positive whole-number count.");
  }
  if (config.encounterDifficultyBands.some((band) => !Number.isFinite(Number(band.min))
    || !Number.isFinite(Number(band.max)) || !Number.isFinite(Number(band.dc)))) {
    throw new Error("Each encounter difficulty band needs numeric min, max, and dc values.");
  }
  const bands = [...config.encounterDifficultyBands].sort((left, right) => Number(left.min) - Number(right.min));
  let nextRoll = 1;
  for (const band of bands) {
    if (!Number.isInteger(Number(band.min)) || !Number.isInteger(Number(band.max))
      || Number(band.min) !== nextRoll || Number(band.max) < Number(band.min)) {
      throw new Error("Encounter difficulty bands must form contiguous integer ranges from 1 through 20.");
    }
    nextRoll = Number(band.max) + 1;
  }
  if (nextRoll !== 21) throw new Error("Encounter difficulty bands must cover d20 results 1 through 20.");
  config.damageCap = Math.min(1, Math.max(0, numberValue(config.damageCap, "damageCap")));
  return config;
}

async function readConfig() {
  const raw = game.settings.get(MODULE_ID, "configuration");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`The Quick Battles configuration is not valid JSON: ${error.message}`);
  }
  return normalizeConfig(parsed);
}

async function writeConfig(config) {
  const normalized = normalizeConfig(config);
  await effectiveCatalog(normalized);
  await game.settings.set(MODULE_ID, "configuration", JSON.stringify(normalized));
  return normalized;
}

function readConfigurationForm(element, baseConfig = DEFAULT_CONFIG) {
  const field = (row, name) => row.querySelector(`[data-field="${name}"]`);
  const text = (row, name) => field(row, name)?.value.trim() ?? "";
  const number = (row, name) => Number(field(row, name)?.value);
  const rows = (collection) => Array.from(element.querySelectorAll(`[data-config-collection="${collection}"] [data-config-row]`));
  const config = clone(baseConfig);

  config.players = rows("players").map((row) => ({
    userId: text(row, "userId"),
    actorUuid: text(row, "actorUuid")
  }));
  config.encounterGroups = rows("encounterGroups").map((row) => ({
    id: text(row, "id"),
    name: text(row, "name")
  }));
  config.encounters = rows("encounters").map((row) => {
    const id = text(row, "id");
    const existing = baseConfig.encounters.find((encounter) => encounter.id === id) ?? {};
    return {
      ...existing,
      id,
      name: text(row, "name"),
      groups: Array.from(row.querySelectorAll('[data-field="groups"]:checked')).map((input) => input.value)
    };
  });
  config.encounterDifficultyBands = rows("encounterDifficultyBands").map((row) => ({
    min: number(row, "min"),
    max: number(row, "max"),
    label: text(row, "label"),
    dc: number(row, "dc"),
    ...(field(row, "combat")?.checked ? { combat: true } : {})
  }));
  config.catalogOverrides = rows("catalogOverrides").map((row) => {
    const index = Number(row.dataset.configIndex);
    const override = { ...(baseConfig.catalogOverrides[index] ?? {}) };
    override.name = text(row, "name");
    override.type = text(row, "type");
    override.rating = text(row, "rating");
    override.disabled = field(row, "disabled")?.checked ?? false;
    const description = text(row, "description");
    if (description) override.description = description;
    else delete override.description;
    for (const name of ["bonus", "bonusPerUse"]) {
      const value = field(row, name)?.value;
      if (value == null || value.trim() === "") delete override[name];
      else override[name] = Number(value);
    }
    return override;
  });
  config.fateDcs = {
    easy: number(element, "fateDcEasy"),
    medium: number(element, "fateDcMedium"),
    hard: number(element, "fateDcHard")
  };
  config.campBonus = number(element, "campBonus");
  config.paceModifiers = {
    fast: number(element, "paceFast"),
    normal: number(element, "paceNormal"),
    slow: number(element, "paceSlow")
  };
  config.spellSlotBonuses = Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => {
      const level = index + 1;
      return [level, number(element, `spellSlot${level}`)];
    })
  );
  config.damageCap = number(element, "damageCap");
  config.postGmResults = field(element, "postGmResults")?.checked ?? false;
  return config;
}

async function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = (async () => {
      const response = await fetch(`modules/${MODULE_ID}/data/feat-catalog.csv`);
      if (!response.ok) throw new Error(`Unable to load the feat catalog (${response.status}).`);
      return parseFeatCatalog(await response.text());
    })();
  }
  return catalogPromise;
}

async function effectiveCatalog(config) {
  return mergeCatalog(await loadCatalog(), config.catalogOverrides);
}

function registerModuleSettings() {
  game.settings.register(MODULE_ID, "configuration", {
    name: "Quick Battles configuration",
    hint: "Shared world configuration used by the Quick Battles window.",
    scope: "world",
    config: false,
    type: String,
    default: JSON.stringify(DEFAULT_CONFIG)
  });
  game.settings.register(MODULE_ID, "lastSelection", {
    name: "Quick Battles last selection",
    scope: "client",
    config: false,
    type: Object,
    default: DEFAULT_LAST_SELECTION
  });
  game.settings.register(MODULE_ID, "activeRun", {
    name: "Quick Battles active run",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });
  game.settings.registerMenu(MODULE_ID, "configurationMenu", {
    name: "Quick Battles configuration",
    label: "Configure",
    hint: "Set up player characters, encounters, and Quick Battles rules.",
    icon: "fas fa-sliders",
    type: QuickBattlesConfigurationApplication,
    restricted: true
  });

  if (!Handlebars.helpers.signed) {
    Handlebars.registerHelper("signed", (value) => {
      const number = Number(value) || 0;
      return number > 0 ? `+${number}` : String(number);
    });
  }

  game.keybindings.register(MODULE_ID, "open", {
    name: "Open Quick Battles",
    editable: [{ key: "KeyB", modifiers: ["SHIFT", "ALT"] }],
    onDown: () => {
      if (!game.user.isGM) {
        ui.notifications.warn("Only a GM can open Quick Battles.");
        return false;
      }
      openMainApplication().catch(notifyError);
      return true;
    }
  });
}

function newestRunMessage() {
  return Array.from(game.messages)
    .filter((message) => message.flags?.[MODULE_ID]?.type === "run-state")
    .sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0))[0] ?? null;
}

async function currentRunMessage() {
  if (activeRunMessage && game.messages.get(activeRunMessage.id)) return activeRunMessage;
  activeRunMessage = newestRunMessage();
  return activeRunMessage;
}

async function currentRun(runId) {
  const serializedRun = game.settings.get(MODULE_ID, "activeRun");
  let run = null;
  if (serializedRun) {
    try {
      run = JSON.parse(serializedRun);
    } catch (error) {
      throw new Error(`The active Quick Battles run is not valid JSON: ${error.message}`);
    }
  }
  const message = run ? null : await currentRunMessage();
  run ??= message?.flags?.[MODULE_ID]?.state ?? null;
  if (!run || (runId && run.id !== runId)) return null;
  return { message, run };
}

async function persistRun(run, message = null) {
  const payload = { type: "run-state", runId: run.id, state: run };
  await game.settings.set(MODULE_ID, "activeRun", JSON.stringify(run));
  if (message) {
    await message.update({ [`flags.${MODULE_ID}`]: payload });
    activeRunMessage = message;
    return message;
  }
  return null;
}

async function rememberSelection(selection) {
  const current = game.settings.get(MODULE_ID, "lastSelection") ?? DEFAULT_LAST_SELECTION;
  await game.settings.set(MODULE_ID, "lastSelection", { ...current, ...selection });
}

function statusLabel(run) {
  if (!run) return "";
  if (run.status === "fate-pending") return run.fate.pace === "stealth" ? "Waiting for group Stealth checks." : "Waiting for the selected player's d20.";
  if (run.status === "fate-resolving") return "The Fate roll is complete; resolving the result.";
  if (run.status === "fate-resolved") return run.fateResult?.failed ? "Threat detected; choose an encounter group." : "No threat detected.";
  if (run.status === "checks-pending") return "Participant checks are in progress.";
  if (run.status === "checks-resolved") return "All participant checks are resolved.";
  if (run.status === "cancelled") return "This Quick Battle was cancelled. Start a new Fate check when ready.";
  return run.status;
}

function sortActors() {
  return Array.from(game.actors)
    .filter((actor) => ["character", "npc"].includes(actor.type))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function playerActorOptions(user) {
  if (user.isGM) return sortActors();
  return Array.from(game.actors)
    .filter((actor) => actor.type === "character")
    .filter((actor) => actor.testUserPermission(user, "OWNER"))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function classLine(actor) {
  const items = Array.from(actor.items ?? []);
  const classes = items.filter((item) => item.type === "class");
  const subclasses = items.filter((item) => item.type === "subclass");
  return classes.map((item) => {
    const subclass = subclasses.find((entry) => entry.system?.classIdentifier === item.system?.identifier);
    const level = Number(item.system?.levels) || 0;
    return `${subclass ? `${subclass.name} ` : ""}${item.name} ${level}`.trim();
  }).join(" / ") || "No class data";
}

async function actorByUuid(uuid) {
  const actor = await fromUuid(uuid);
  if (!actor || !["character", "npc"].includes(actor.type)) {
    throw new Error(`Actor not found or unsupported: ${uuid}`);
  }
  return actor;
}

function actorAbilities(actor) {
  return actor.system?.abilities ?? {};
}

function participantPreview(actor, catalog, config) {
  const items = Array.from(actor.items ?? []);
  const catalogBonuses = selectedCatalogBonuses(catalog, items);
  const passive = calculatePassiveBonuses({
    abilities: actorAbilities(actor),
    currentHp: actor.system?.attributes?.hp?.value,
    ac: actor.system?.attributes?.ac?.value,
    catalogBonus: catalogBonuses.passiveBonus
  });
  const hp = Number(actor.system?.attributes?.hp?.value) || 0;
  const maxHp = Number(actor.system?.attributes?.hp?.max) || 0;
  const spellSlots = availableSpellSlots(actor.system?.spells, config.spellSlotBonuses);
  const spells = items
    .filter((item) => item.type === "spell")
    .map((item) => ({ name: item.name, level: Number(item.system?.level) || 0 }))
    .sort((left, right) => left.level - right.level || left.name.localeCompare(right.name));

  return {
    actor: {
      uuid: actor.uuid,
      name: actor.name,
      img: actor.img || "icons/svg/mystery-man.svg",
      classLine: classLine(actor),
      hp,
      ac: Number(actor.system?.attributes?.ac?.value) || 0
    },
    maxHp,
    passive,
    passiveEntries: catalogBonuses.passiveEntries,
    activeItems: catalogBonuses.activeEntries,
    spellSlots,
    spells
  };
}

function actorOwners(actor) {
  return Array.from(game.users).filter((user) => !user.isGM && actor.testUserPermission(user, "OWNER"));
}

function recipientsForActor(actor, preferredUserId = null) {
  const preferred = preferredUserId && game.users.get(preferredUserId);
  if (preferred && !preferred.isGM && actor.testUserPermission(preferred, "OWNER")) return [preferred.id];
  const owners = actorOwners(actor);
  return owners.length ? owners.map((user) => user.id) : gmUserIds();
}

function displayRollResult(run) {
  const result = run.fateResult;
  if (!result) return "";
  const difficulty = result.difficulty
    ? `<div>${escapeHtml(result.difficulty.label)} · DC ${escapeHtml(result.difficulty.dc)}</div>`
    : "";
  const watch = result.situation === "camp" && result.watchShift
    ? `<div>Watch shift ${result.watchShift}</div>`
    : "";
  const threatType = result.threatType ? `<div>Threat type roll: ${result.threatType}</div>` : "";
  return `<section class="qb-result"><strong>${escapeHtml(result.label)}</strong><div>${result.total} vs DC ${run.fate.dc}</div>${difficulty}${watch}${threatType}</section>`;
}

function chatCard(content, classes = "") {
  return `<article class="qb-chat ${classes}">${content}</article>`;
}

function findMessageByFlag(type, key, value) {
  return Array.from(game.messages).find((message) => {
    const flag = message.flags?.[MODULE_ID];
    return flag?.type === type && flag?.[key] === value;
  }) ?? null;
}

function findParticipantSubmission(checkId) {
  return findMessageByFlag("participant-submission", "checkId", checkId);
}

function removeOpenCheckButton(checkId) {
  const selector = `[data-card-action="open-check"][data-check-id="${CSS.escape(checkId)}"]`;
  for (const button of document.querySelectorAll(selector)) button.remove();
}

function hideSubmittedCheckAction(message, html) {
  const flag = message.flags?.[MODULE_ID];
  if (flag?.type !== "check-prompt") return;
  if (flag.status === "pending" && !findParticipantSubmission(flag.checkId)) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  root?.querySelector(`[data-card-action="open-check"][data-check-id="${CSS.escape(flag.checkId)}"]`)?.remove();
}

function updateActiveBonusPreview(element) {
  const preview = element.querySelector("[data-active-bonus-preview]");
  if (!preview) return;
  const entries = Array.from(element.querySelectorAll("[data-bonus-count]")).map((input) => ({
    count: input.value,
    bonusPerUse: input.dataset.bonusPerUse
  }));
  const bonus = resourceBonus(entries);
  preview.querySelector("[data-bonus-total]").textContent = `${bonus >= 0 ? "+" : ""}${bonus}`;
}

function createButton(label, action, attributes = "") {
  return `<button type="button" data-card-action="${escapeHtml(action)}" ${attributes}>${escapeHtml(label)}</button>`;
}

async function createFateRequest(run, selectedUser) {
  const paceText = run.fate.pace === "stealth"
    ? "Configured characters will make individual native Stealth checks."
    : `${escapeHtml(selectedUser.name)} will make the d20 roll.`;
  const button = run.fate.pace === "stealth"
    ? ""
    : createButton("Roll d20", "fate-roll", `data-run-id="${run.id}" data-request-id="${run.fate.requestId}" data-user-id="${selectedUser.id}"`);
  const message = await ChatMessage.create({
    content: chatCard(`<h3>Quick Battles · Fate check</h3><p>${paceText}</p><p>DC ${run.fate.dc}</p>${button}`, "qb-fate-card"),
    flags: {
      [MODULE_ID]: {
        type: "fate-request",
        runId: run.id,
        requestId: run.fate.requestId,
        userId: selectedUser?.id ?? null,
        status: "pending"
      }
    }
  });
  run.fate.promptId = message.id;
  return message;
}

async function createStealthPrompts(run, config, stateMessage) {
  const requests = [];
  for (const entry of config.players) {
    const actor = await actorByUuid(entry.actorUuid);
    requests.push({
      requestId: randomId(),
      actorUuid: actor.uuid,
      actorName: actor.name,
      userId: entry.userId,
      promptId: null,
      total: null
    });
  }
  run.fate.stealthRequests = requests;
  await persistRun(run, stateMessage);

  for (const request of requests) {
    const actor = await actorByUuid(request.actorUuid);
    const button = createButton("Roll Stealth", "stealth-roll", `data-run-id="${run.id}" data-request-id="${request.requestId}" data-actor-uuid="${escapeHtml(actor.uuid)}" data-user-id="${escapeHtml(request.userId)}"`);
    const prompt = await ChatMessage.create({
      content: chatCard(`<h3>Quick Battles · Group Stealth</h3><p>${escapeHtml(actor.name)}: make a native Stealth check.</p>${button}`),
      whisper: recipientsForActor(actor, request.userId),
      flags: {
        [MODULE_ID]: {
          type: "stealth-request",
          runId: run.id,
          requestId: request.requestId,
          actorUuid: actor.uuid,
          userId: request.userId,
          status: "pending"
        }
      }
    });
    const current = await currentRun(run.id);
    const currentRequest = current?.run.fate.stealthRequests.find((entry) => entry.requestId === request.requestId);
    if (!currentRequest || currentRequest.total != null) {
      await prompt.delete();
    } else {
      currentRequest.promptId = prompt.id;
      await persistRun(current.run, current.message);
    }
  }
}

async function openMainApplication() {
  if (!game.user.isGM) throw new Error("Only a GM can open Quick Battles.");
  const config = await readConfig();
  await effectiveCatalog(config);
  mainApplication ??= new QuickBattlesApplication({ mode: "gm" });
  await mainApplication.render({ force: true });
}

class QuickBattlesConfigurationApplication extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-configuration`,
    classes: ["quick-battles-app", "quick-battles-config"],
    position: { width: 720, height: "auto" },
    window: { title: "Quick Battles Configuration", resizable: true }
  };

  static PARTS = {
    main: { template: CONFIG_TEMPLATE }
  };

  constructor(options = {}) {
    const viewportWidth = window.innerWidth;
    const width = Math.min(
      Math.max(Math.round(viewportWidth * 0.7), Math.min(384, viewportWidth - 16)),
      viewportWidth - 16
    );
    super({
      ...options,
      position: { width, height: "auto", ...options.position }
    });
    this.configDraft = null;
    this.actorOptions = [];
    this.users = [];
    this.activeEncounterId = null;
  }

  async _prepareContext() {
    if (!game.user.isGM) throw new Error("Only a GM can configure Quick Battles.");
    const config = this.configDraft ?? await readConfig();
    this.configDraft ??= clone(config);
    const users = Array.from(game.users)
      .map((user) => ({ id: user.id, name: user.name }));
    const actors = sortActors().map((actor) => ({ uuid: actor.uuid, name: actor.name }));
    this.actorOptions = actors;
    this.users = users;
    const withSelectedOption = (options, selected, valueKey) => {
      const prepared = options.map((option) => ({ ...option, selected: option[valueKey] === selected }));
      if (selected && !prepared.some((option) => option[valueKey] === selected)) {
        prepared.unshift({ [valueKey]: selected, name: "Unavailable selection", selected: true });
      }
      return prepared;
    };
    const preparedConfig = {
      ...config,
      players: config.players.map((player) => {
        const user = game.users.get(player.userId);
        const ownedCharacters = user ? playerActorOptions(user).map((actor) => ({
          uuid: actor.uuid,
          name: actor.name
        })) : [];
        const selectedActors = withSelectedOption(ownedCharacters, player.actorUuid, "uuid");
        return {
          ...player,
          users: withSelectedOption(users, player.userId, "id"),
          actors: selectedActors
        };
      }),
      encounters: config.encounters.map((encounter) => ({
        ...encounter,
        groupOptions: config.encounterGroups.map((group) => ({
          ...group,
          selected: encounter.groups.includes(group.id)
        })),
        selectedGroupSummary: config.encounterGroups
          .filter((group) => encounter.groups.includes(group.id))
          .map((group) => group.name)
          .join(", ") || "Select encounter groups",
        roster: (encounter.roster ?? []).map((member) => ({
          ...member,
          actorUuid: member.actorUuid ?? game.actors.get(member.actorId)?.uuid ?? "",
          actors: withSelectedOption(actors, member.actorUuid ?? game.actors.get(member.actorId)?.uuid, "uuid")
        }))
      })),
      encounterDifficultyBands: config.encounterDifficultyBands.map((band) => ({
        ...band,
        isCombat: band.combat === true
      })),
      catalogOverrides: config.catalogOverrides.map((override) => ({
        ...override,
        isPassive: override.type === "Passive",
        isActive: override.type === "Active",
        isLow: override.rating === "Low",
        isMedium: override.rating === "Medium",
        isHigh: override.rating === "High"
      })),
      spellSlots: Array.from({ length: 9 }, (_, index) => {
        const level = index + 1;
        return { level, bonus: config.spellSlotBonuses[level] };
      })
    };
    const configuredUsers = new Set(config.players.map((player) => player.userId));
    const availableUsers = users.filter((user) => !configuredUsers.has(user.id));
    return { config: preparedConfig, users, actors, availableUsers };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (this.element?.dataset.qbConfigBound) return;
    this.element.dataset.qbConfigBound = "true";
    this.element.addEventListener("click", (event) => {
      const button = event.target.closest("[data-app-action]");
      if (!button) return;
      event.preventDefault();
      this._handleConfigurationAction(button).catch(notifyError);
    });
    this.element.addEventListener("change", (event) => {
      const field = event.target;
      if (field.matches('[data-app-action="add-player"]')) {
        this._handleConfigurationAction(field).catch(notifyError);
      } else if (field.matches('[data-field="userId"]')) {
        this._updateMainCharacterOptions(field.closest("[data-config-row]"), field.value);
        this._refreshAvailablePlayers();
      } else if (field.matches('[data-field="groups"]')) {
        this._updateGroupSummaries();
      }
    });
    this.element.addEventListener("input", (event) => {
      const field = event.target;
      if (field.matches('[data-config-collection="encounterGroups"] [data-field="name"]')) {
        this._updateGroupSummaries();
      }
    });
  }

  _updateGroupSummaries() {
    const groups = new Map(Array.from(this.element.querySelectorAll(
      '[data-config-collection="encounterGroups"] [data-config-row]'
    )).map((row) => [
      row.querySelector('[data-field="id"]').value,
      row.querySelector('[data-field="name"]').value.trim()
    ]));
    for (const row of this.element.querySelectorAll('[data-config-collection="encounters"] [data-config-row]')) {
      const selectedNames = [];
      for (const option of row.querySelectorAll('[data-field="groups"]')) {
        const name = groups.get(option.value) ?? "";
        option.closest("label").querySelector("[data-group-name]").textContent = name;
        if (option.checked && name) selectedNames.push(name);
      }
      row.querySelector("[data-group-summary]").textContent = selectedNames.join(", ") || "Select encounter groups";
    }
  }

  _updateMainCharacterOptions(row, userId) {
    const select = row.querySelector('[data-field="actorUuid"]');
    const currentUuid = select.value;
    const user = game.users.get(userId);
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select an actor";
    select.replaceChildren(placeholder);
    if (user) {
      const actors = playerActorOptions(user);
      for (const actor of actors) {
        const option = document.createElement("option");
        option.value = actor.uuid;
        option.textContent = actor.name;
        select.append(option);
      }
      if (actors.some((actor) => actor.uuid === currentUuid)) select.value = currentUuid;
    }
  }

  _refreshAvailablePlayers() {
    const select = this.element.querySelector('[data-app-action="add-player"]');
    const configuredUsers = new Set(Array.from(this.element.querySelectorAll(
      '[data-config-collection="players"] [data-field="userId"]'
    )).map((field) => field.value).filter(Boolean));
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a player";
    select.replaceChildren(placeholder);
    for (const user of this.users) {
      if (configuredUsers.has(user.id)) continue;
      const option = document.createElement("option");
      option.value = user.id;
      option.textContent = user.name;
      select.append(option);
    }
  }

  _createRosterRow(member = {}) {
    const row = document.createElement("div");
    row.dataset.rosterRow = "";
    row.className = "qb-roster-config-row";

    const actorLabel = document.createElement("label");
    actorLabel.className = "qb-field qb-actor-field";
    const actorLabelText = document.createElement("span");
    actorLabelText.textContent = "Actor";
    const actorSelect = document.createElement("select");
    actorSelect.dataset.dialogField = "actorUuid";
    actorSelect.setAttribute("aria-label", "Enemy actor");
    actorSelect.size = this.actorOptions.length > 10 ? 10 : 1;
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Use a custom name";
    actorSelect.append(placeholder);
    const selectedUuid = member.actorUuid ?? game.actors.get(member.actorId)?.uuid ?? "";
    for (const actor of this.actorOptions) {
      const option = document.createElement("option");
      option.value = actor.uuid;
      option.textContent = actor.name;
      option.selected = actor.uuid === selectedUuid;
      actorSelect.append(option);
    }
    if (selectedUuid && !this.actorOptions.some((actor) => actor.uuid === selectedUuid)) {
      const unavailable = document.createElement("option");
      unavailable.value = selectedUuid;
      unavailable.textContent = "Unavailable selection";
      unavailable.selected = true;
      actorSelect.append(unavailable);
    }
    actorLabel.append(actorLabelText, actorSelect);

    const nameLabel = document.createElement("label");
    nameLabel.className = "qb-field";
    const nameText = document.createElement("span");
    nameText.textContent = "Custom name";
    const nameInput = document.createElement("input");
    nameInput.dataset.dialogField = "name";
    nameInput.value = member.name ?? "";
    nameInput.placeholder = "Optional";
    nameLabel.append(nameText, nameInput);

    const countLabel = document.createElement("label");
    countLabel.className = "qb-field";
    const countText = document.createElement("span");
    countText.textContent = "Count";
    const countInput = document.createElement("input");
    countInput.dataset.dialogField = "count";
    countInput.type = "number";
    countInput.min = "1";
    countInput.step = "1";
    countInput.value = member.count ?? 1;
    countInput.required = true;
    countLabel.append(countText, countInput);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "qb-secondary";
    removeButton.dataset.appAction = "remove-row";
    removeButton.textContent = "Remove enemy";
    row.append(actorLabel, nameLabel, countLabel, removeButton);
    return row;
  }

  _openEncounterDialog(button) {
    const form = this.element.querySelector(".qb-configuration-form");
    this.configDraft = readConfigurationForm(form, this.configDraft ?? DEFAULT_CONFIG);
    const encounterId = button.closest("[data-encounter-id]").dataset.encounterId;
    const encounter = this.configDraft.encounters.find((entry) => entry.id === encounterId);
    if (!encounter) throw new Error("The selected encounter could not be found.");
    this.activeEncounterId = encounterId;
    const dialog = this.element.querySelector("[data-encounter-dialog]");
    dialog.querySelector("[data-dialog-title]").textContent = `Configure ${encounter.name || "encounter"}`;
    dialog.querySelector('[data-dialog-field="description"]').value = encounter.description ?? "";
    dialog.querySelector('[data-dialog-field="difficultyLabel"]').value = encounter.difficultyLabel ?? "";
    dialog.querySelector('[data-dialog-field="dc"]').value = encounter.dc ?? "";
    const roster = dialog.querySelector("[data-dialog-roster]");
    roster.replaceChildren(...(encounter.roster ?? []).map((member) => this._createRosterRow(member)));
    dialog.showModal();
  }

  _saveEncounterDialog() {
    const dialog = this.element.querySelector("[data-encounter-dialog]");
    for (const input of dialog.querySelectorAll("input:invalid, select:invalid, textarea:invalid")) {
      if (!input.reportValidity()) return;
    }
    this.configDraft = readConfigurationForm(
      this.element.querySelector(".qb-configuration-form"),
      this.configDraft ?? DEFAULT_CONFIG
    );
    const encounter = this.configDraft.encounters.find((entry) => entry.id === this.activeEncounterId);
    if (!encounter) throw new Error("The encounter being edited no longer exists.");
    encounter.description = dialog.querySelector('[data-dialog-field="description"]').value.trim();
    encounter.difficultyLabel = dialog.querySelector('[data-dialog-field="difficultyLabel"]').value.trim();
    const dc = dialog.querySelector('[data-dialog-field="dc"]').value.trim();
    if (dc === "") delete encounter.dc;
    else encounter.dc = Number(dc);
    encounter.roster = Array.from(dialog.querySelectorAll("[data-dialog-roster] [data-roster-row]"))
      .map((row) => ({
        actorUuid: row.querySelector('[data-dialog-field="actorUuid"]').value,
        name: row.querySelector('[data-dialog-field="name"]').value.trim(),
        count: Number(row.querySelector('[data-dialog-field="count"]').value)
      }))
      .filter((member) => member.actorUuid || member.name);
    dialog.close();
    this.activeEncounterId = null;
  }

  async _confirmGroupDeletion(groupName, linkedCount, replacementName) {
    const dialog = this.element.querySelector("[data-group-confirm-dialog]");
    const noun = linkedCount === 1 ? "encounter" : "encounters";
    dialog.querySelector("[data-confirm-message]").textContent = (
      `“${groupName}” is linked to ${linkedCount} ${noun}. If you continue, `
      + `those ${noun} will also be assigned to “${replacementName}”.`
    );
    const result = new Promise((resolve) => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
    });
    dialog.returnValue = "";
    dialog.showModal();
    return result;
  }

  async _removeEncounterGroup(button) {
    const form = this.element.querySelector(".qb-configuration-form");
    const draft = readConfigurationForm(form, this.configDraft ?? DEFAULT_CONFIG);
    const row = button.closest("[data-config-row]");
    const groupId = row.querySelector('[data-field="id"]').value;
    if (draft.encounterGroups.length <= 1) {
      ui.notifications.warn("At least one encounter group must remain.");
      return;
    }
    const group = draft.encounterGroups.find((entry) => entry.id === groupId);
    if (!group) throw new Error("The selected encounter group could not be found.");
    const linked = draft.encounters.filter((encounter) => encounter.groups.includes(groupId));
    const remaining = draft.encounterGroups.filter((entry) => entry.id !== groupId);
    if (linked.length) {
      const confirmed = await this._confirmGroupDeletion(group.name, linked.length, remaining[0].name);
      if (!confirmed) return;
    }
    draft.encounterGroups = remaining;
    draft.encounters = reassignEncounterGroup(draft.encounters, groupId, remaining[0].id);
    this.configDraft = draft;
    return this.render();
  }

  async _handleConfigurationAction(button) {
    const action = button.dataset.appAction;
    if (action === "save-config") {
      const form = this.element.querySelector(".qb-configuration-form");
      if (!form.reportValidity()) return;
      this.configDraft = await writeConfig(readConfigurationForm(form, this.configDraft ?? DEFAULT_CONFIG));
      ui.notifications.info("Quick Battles configuration saved.");
      mainApplication?.render();
      return this.close();
    }
    if (action === "remove-row") {
      const row = button.closest("[data-config-row], [data-roster-row]");
      if (row?.closest("[data-dialog-roster]")) {
        row.remove();
        return;
      }
      const form = this.element.querySelector(".qb-configuration-form");
      this.configDraft = readConfigurationForm(form, this.configDraft ?? DEFAULT_CONFIG);
      row?.remove();
      this.configDraft = readConfigurationForm(form, this.configDraft);
      return this.render();
    }
    if (action === "remove-group") {
      return this._removeEncounterGroup(button);
    }
    if (action === "edit-encounter") {
      return this._openEncounterDialog(button);
    }
    if (action === "cancel-encounter-dialog") {
      this.element.querySelector("[data-encounter-dialog]").close();
      this.activeEncounterId = null;
      return;
    }
    if (action === "save-encounter-dialog") {
      return this._saveEncounterDialog();
    }
    if (action === "add-dialog-roster") {
      this.element.querySelector("[data-dialog-roster]").append(this._createRosterRow());
      return;
    }
    const form = this.element.querySelector(".qb-configuration-form");
    this.configDraft = readConfigurationForm(form, this.configDraft ?? DEFAULT_CONFIG);
    if (action === "add-player") {
      if (!button.value) return;
      this.configDraft.players.push({ userId: button.value, actorUuid: "" });
    }
    else if (action === "add-group") this.configDraft.encounterGroups.push({ id: randomId(), name: "" });
    else if (action === "add-encounter") {
      this.configDraft.encounters.push({
        id: randomId(),
        name: "",
        description: "",
        groups: this.configDraft.encounterGroups[0] ? [this.configDraft.encounterGroups[0].id] : [],
        roster: []
      });
    } else if (action === "add-band") {
      this.configDraft.encounterDifficultyBands.push({ min: 1, max: 0, label: "", dc: 0 });
    } else if (action === "add-override") {
      this.configDraft.catalogOverrides.push({ name: "", type: "Active", rating: "Low" });
    }
    return this.render();
  }
}

class QuickBattlesApplication extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-window`,
    classes: ["quick-battles-app"],
    position: { width: 960, height: "auto" },
    window: { title: "Quick Battles", resizable: true }
  };

  static PARTS = {
    main: { template: TEMPLATE }
  };

  constructor(options = {}) {
    const isParticipant = options.mode === "participant";
    super({
      ...options,
      id: options.id ?? (isParticipant ? `${MODULE_ID}-check-${options.checkId}` : `${MODULE_ID}-window`),
      position: { width: isParticipant ? 500 : 960, height: "auto", ...options.position },
      window: { title: isParticipant ? "Quick Battle check" : "Quick Battles", resizable: true }
    });
    this.mode = options.mode ?? "gm";
  }

  async _prepareContext() {
    if (this.mode === "participant") return this._prepareParticipantContext();
    const config = await readConfig();
    const lastSelection = game.settings.get(MODULE_ID, "lastSelection") ?? DEFAULT_LAST_SELECTION;
    const selectedArea = ["easy", "medium", "hard"].includes(lastSelection.area)
      ? lastSelection.area
      : DEFAULT_LAST_SELECTION.area;
    const selectedGroupId = config.encounterGroups.some((group) => group.id === lastSelection.encounterGroupId)
      ? lastSelection.encounterGroupId
      : config.encounterGroups[0]?.id;
    const current = await currentRun();
    const run = current?.run ?? null;
    const configuredActorIds = new Set(config.players.map((entry) => entry.actorUuid));
    const selectedIds = new Set(run?.participantIds ?? configuredActorIds);
    const checkedStatuses = run?.checks ?? {};
    const actors = await Promise.all(config.players.map(async (entry) => {
      const actor = await actorByUuid(entry.actorUuid);
      return {
        uuid: entry.actorUuid,
        name: actor.name,
        defaultSelected: selectedIds.has(entry.actorUuid),
        checkStatus: checkedStatuses[entry.actorUuid]?.statusLabel ?? ""
      };
    }));
    actors.sort((left, right) => left.name.localeCompare(right.name));
    const rolls = run
      ? run.fate.pace === "stealth"
        ? run.fate.stealthRequests.map((request) => ({
          label: request.actorName ?? request.actorUuid,
          total: request.total,
          pending: request.total == null
        }))
        : [{
          label: `${run.fate.selectedUserName ?? "Selected player"} d20`,
          total: run.fate.d20,
          pending: run.fate.d20 == null
        }]
      : [];

    return {
      isParticipant: false,
      config,
      fateAreas: [
        { value: "easy", label: "Easy", dc: config.fateDcs.easy, selected: selectedArea === "easy" },
        { value: "medium", label: "Medium", dc: config.fateDcs.medium, selected: selectedArea === "medium" },
        { value: "hard", label: "Hard", dc: config.fateDcs.hard, selected: selectedArea === "hard" }
      ],
      groups: config.encounterGroups.map((group) => ({
        ...group,
        selected: group.id === selectedGroupId
      })),
      actors,
      rolls,
      canChooseEncounter: run?.status === "fate-resolved" && run.fateResult?.failed === true,
      canStartChecks: run?.status === "encounter-selected",
      canCancelRun: run?.status !== "cancelled",
      showCurrentRun: isRunActive(run),
      state: run ? { ...run, statusLabel: statusLabel(run) } : null
    };
  }

  async _prepareParticipantContext() {
    const prompt = findMessageByFlag("check-prompt", "checkId", this.options.checkId);
    const payload = prompt?.flags?.[MODULE_ID];
    if (!payload || payload.status !== "pending") {
      throw new Error("This participant check is no longer pending.");
    }
    const actor = await actorByUuid(payload.actorUuid);
    if (!game.user.isGM && !actor.testUserPermission(game.user, "OWNER")) {
      throw new Error(`You do not own ${actor.name}.`);
    }
    const expected = payload.preview;
    const activeItems = expected.activeItems.map((option) => {
      const item = actor.items.get(option.itemId);
      return { ...option, available: itemUses(item).available };
    }).filter((option) => option.available > 0);
    const currentSpellSlots = availableSpellSlots(actor.system?.spells);
    const spellSlots = expected.spellSlots.flatMap((slot) => {
      const current = currentSpellSlots.find((entry) => entry.level === slot.level);
      return current ? [{ ...slot, available: current.available }] : [];
    });
    return {
      isParticipant: true,
      checkId: payload.checkId,
      actor: expected.actor,
      passive: expected.passive,
      passiveEntries: expected.passiveEntries,
      activeItems,
      spellSlots,
      spells: expected.spells,
      situational: payload.situational,
      dc: payload.dc
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (this.element?.dataset.qbBound) return;
    this.element.dataset.qbBound = "true";
    this.element.addEventListener("click", (event) => {
      const button = event.target.closest("[data-app-action]");
      if (!button) return;
      event.preventDefault();
      this._handleAppAction(button.dataset.appAction).catch(notifyError);
    });
    this.element.addEventListener("change", (event) => {
      const field = event.target;
      if (field.name === "area") rememberSelection({ area: field.value }).catch(notifyError);
      else if (field.name === "encounter-group") {
        rememberSelection({ encounterGroupId: field.value }).catch(notifyError);
      }
    });
    this.element.addEventListener("input", (event) => {
      if (this.mode === "participant" && event.target.matches("[data-bonus-count]")) {
        updateActiveBonusPreview(this.element);
      }
    });
    if (this.mode === "participant") updateActiveBonusPreview(this.element);
  }

  async _handleAppAction(action) {
    if (action === "submit-check") return this._submitParticipantCheck();
    if (!game.user.isGM) throw new Error("Only a GM can control the Quick Battles flow.");
    if (action === "start-fate") return enqueueSubmission(() => this._startFate());
    if (action === "choose-encounter") return enqueueSubmission(() => this._chooseEncounter());
    if (action === "start-checks") return enqueueSubmission(() => this._startChecks());
    if (action === "cancel-run") return enqueueSubmission(() => this._cancelRun());
  }

  async _startFate() {
    const config = await readConfig();
    if (config.players.length === 0) throw new Error("Configure at least one player and main character first.");
    const active = await currentRun();
    if (isRunActive(active?.run)) {
      throw new Error("Resolve the current Quick Battles run before starting another.");
    }
    for (const entry of config.players) {
      const user = game.users.get(entry.userId);
      if (!user) throw new Error(`Configured player ${entry.userId} was not found.`);
      const actor = await actorByUuid(entry.actorUuid);
      if (!user.isGM && actor.type !== "character") {
        throw new Error(`${actor.name} must be a character to serve as a player's main character.`);
      }
      if (!user.isGM && !actor.testUserPermission(user, "OWNER")) {
        throw new Error(`${user.name} must own the configured main character ${actor.name}.`);
      }
    }
    const form = this.element.querySelector(".qb-fate-form");
    const situation = form.querySelector('[name="situation"]').value;
    const pace = form.querySelector('[name="pace"]').value;
    const area = form.querySelector('[name="area"]').value;
    await rememberSelection({ area });
    const situational = numberValue(form.querySelector('[name="situational"]').value, "Situational modifier");
    const dc = numberValue(config.fateDcs[area], "Area DC");
    const selected = await new Roll(`1d${config.players.length}`).evaluate();
    const selectedPlayer = config.players[selected.total - 1];
    const playerUser = game.users.get(selectedPlayer.userId);
    if (!playerUser) throw new Error(`Configured player ${selectedPlayer.userId} was not found.`);
    const run = {
      id: randomId(),
      status: "fate-pending",
      fate: {
        situation,
        campModifier: situation === "camp" ? Number(config.campBonus) : 0,
        pace,
        paceModifier: pace === "stealth" ? 0 : Number(config.paceModifiers[pace]),
        situational,
        dc,
        area,
        requestId: randomId(),
        selectedUserId: pace === "stealth" ? null : playerUser.id,
        selectedUserName: pace === "stealth" ? null : playerUser.name,
        stealthRequests: []
      },
      selectedEncounter: null,
      participantIds: [],
      checks: {}
    };
    const stateMessage = await persistRun(run);
    if (pace === "stealth") {
      await createStealthPrompts(run, config, stateMessage);
    } else {
      const request = await createFateRequest(run, playerUser);
      const current = await currentRun(run.id);
      if (current) {
        current.run.fate.promptId = request.id;
        await persistRun(current.run, current.message);
        if (current.run.status !== "fate-pending") {
          await request.update({
            content: chatCard(`<h3>Quick Battles · Fate check resolved</h3><p>${current.run.fateResult.label}: ${current.run.fateResult.total} vs DC ${current.run.fate.dc}.</p>`),
            [`flags.${MODULE_ID}.status`]: "resolved"
          });
        }
      }
    }
    await this.render();
  }

  async _cancelRun() {
    const current = await currentRun();
    if (!current || current.run.status === "cancelled") return;
    current.run.status = "cancelled";
    await persistRun(current.run, current.message);
    const pendingTypes = new Set(["fate-request", "stealth-request", "check-prompt"]);
    for (const message of Array.from(game.messages)) {
      const flag = message.flags?.[MODULE_ID];
      if (flag?.runId !== current.run.id || !pendingTypes.has(flag.type) || flag.status !== "pending") continue;
      await message.update({
        content: chatCard("<h3>Quick Battles · Cancelled</h3><p>This Quick Battle was cancelled by the GM.</p>"),
        [`flags.${MODULE_ID}.status`]: "cancelled"
      });
    }
    await this.render();
  }

  async _chooseEncounter() {
    const config = await readConfig();
    const current = await currentRun();
    if (!current?.run?.fateResult?.failed || current.run.status !== "fate-resolved") {
      throw new Error("Resolve a failed Fate check before choosing an encounter.");
    }
    const groupId = this.element.querySelector('[name="encounter-group"]').value;
    await rememberSelection({ encounterGroupId: groupId });
    const entries = config.encounters.filter((entry) => entry.groups.includes(groupId));
    if (entries.length === 0) throw new Error("The selected encounter group has no entries.");
    const choice = await new Roll(`1d${entries.length}`).evaluate();
    const selected = entries[choice.total - 1];
    const fallbackDifficulty = config.encounterDifficultyBands[0];
    const fateDifficulty = current.run.fateResult.difficulty ?? fallbackDifficulty;
    const roster = await Promise.all((selected.roster ?? []).map(async (member) => {
      const actor = member.actorUuid
        ? await fromUuid(member.actorUuid)
        : game.actors.get(member.actorId);
      if ((member.actorUuid || member.actorId) && !actor) {
        throw new Error(`Encounter roster actor ${member.actorUuid ?? member.actorId} was not found.`);
      }
      return { name: actor?.name ?? member.name ?? "Unknown actor", count: Math.max(1, Number(member.count) || 1) };
    }));
    current.run.selectedEncounter = {
      id: selected.id ?? randomId(),
      groupId,
      name: selected.name,
      description: selected.description ?? "",
      dc: Number(selected.dc ?? fateDifficulty.dc),
      difficultyLabel: selected.difficultyLabel ?? fateDifficulty.label,
      roster
    };
    current.run.participantIds = [...new Set(current.run.participantIds.length
      ? current.run.participantIds
      : config.players.map((entry) => entry.actorUuid))];
    current.run.checks = {};
    current.run.status = "encounter-selected";
    await persistRun(current.run, current.message);
    await ChatMessage.create({
      content: chatCard(
        `<header><div><span class="qb-eyebrow">Encounter selected</span><h3>${escapeHtml(selected.name)}</h3></div><span class="qb-encounter-difficulty">${escapeHtml(current.run.selectedEncounter.difficultyLabel)} · DC ${escapeHtml(current.run.selectedEncounter.dc)}</span></header><p>${escapeHtml(selected.description ?? "")}</p>`,
        "qb-encounter-card"
      ),
      flags: {
        [MODULE_ID]: {
          type: "encounter-card",
          runId: current.run.id,
          encounterId: current.run.selectedEncounter.id
        }
      }
    });
    await this.render();
  }

  async _startChecks() {
    const config = await readConfig();
    const current = await currentRun();
    if (!current?.run?.selectedEncounter || current.run.status !== "encounter-selected") {
      throw new Error("Choose an encounter before prompting checks.");
    }
    const configuredActorUuids = new Set(config.players.map((entry) => entry.actorUuid));
    const selectedUuids = [...new Set(Array.from(this.element.querySelectorAll(".qb-participant:checked"))
      .map((input) => input.value))];
    if (selectedUuids.length === 0) throw new Error("Select at least one participant.");
    if (selectedUuids.some((actorUuid) => !configuredActorUuids.has(actorUuid))) {
      throw new Error("Only configured players' main characters can participate.");
    }
    const catalog = await effectiveCatalog(config);
    current.run.participantIds = selectedUuids;
    current.run.status = "checks-pending";
    current.run.checks = {};
    const participants = [];

    for (const actorUuid of selectedUuids) {
      const actor = await actorByUuid(actorUuid);
      const sitInput = Array.from(this.element.querySelectorAll(".qb-situational"))
        .find((input) => input.dataset.actorUuid === actorUuid);
      const situational = numberValue(sitInput?.value ?? 0, `Situational modifier for ${actor.name}`);
      const checkId = randomId();
      const preview = participantPreview(actor, catalog, config);
      const preferredUser = config.players.find((entry) => entry.actorUuid === actorUuid)?.userId ?? null;
      const recipients = recipientsForActor(actor, preferredUser);
      current.run.checks[actorUuid] = {
        checkId,
        promptId: null,
        status: "pending",
        statusLabel: "Pending"
      };
      participants.push({ actor, actorUuid, checkId, situational, preview, recipients });
    }

    await persistRun(current.run, current.message);
    for (const participant of participants) {
      const { actor, actorUuid, checkId, situational, preview, recipients } = participant;
      const prompt = await ChatMessage.create({
        content: chatCard(`<h3>Quick Battle check · ${escapeHtml(actor.name)}</h3><p>Target DC ${current.run.selectedEncounter.dc}. Choose resources and roll your check.</p>${createButton("Open check", "open-check", `data-check-id="${checkId}"`)}`),
        whisper: recipients,
        flags: {
          [MODULE_ID]: {
            type: "check-prompt",
            runId: current.run.id,
            checkId,
            actorUuid,
            dc: current.run.selectedEncounter.dc,
            situational,
            status: "pending",
            config: { spellSlotBonuses: config.spellSlotBonuses },
            preview
          }
        }
      });
      const latest = await currentRun(current.run.id);
      const check = latest?.run.checks[actorUuid];
      if (check?.status === "pending") {
        check.promptId = prompt.id;
        await persistRun(latest.run, latest.message);
      } else {
        await prompt.delete();
      }
    }

    await this.render();
  }

  async _submitParticipantCheck() {
    const checkId = this.options.checkId;
    const prompt = findMessageByFlag("check-prompt", "checkId", checkId);
    const payload = prompt?.flags?.[MODULE_ID];
    if (!payload || payload.status !== "pending") throw new Error("This check has already been submitted or is no longer available.");
    const lockKey = `participant:${checkId}`;
    if (inFlight.has(lockKey)) return;
    inFlight.add(lockKey);

    try {
      const actor = await actorByUuid(payload.actorUuid);
      if (!game.user.isGM && !actor.testUserPermission(game.user, "OWNER")) {
        throw new Error(`You do not own ${actor.name}.`);
      }
      const config = normalizeConfig({ ...DEFAULT_CONFIG, ...payload.config });
      const preview = payload.preview;
      const activePlan = this._activeSpendPlan(actor, preview.activeItems);
      const slotPlan = this._slotSpendPlan(actor, preview.spellSlots, config.spellSlotBonuses);
      const situational = numberValue(this.element.querySelector('[name="situational"]').value, "Situational modifier");
      const totalModifier = preview.passive.total + activePlan.bonus + slotPlan.bonus + situational;
      const roll = await nativeD20(actor, totalModifier, `Quick Battle check · ${actor.name}`);
      if (!roll) return;
      await applyResourceUpdates(actor, activePlan.updates, slotPlan.updates);
      const total = Number(roll.total);
      const passed = total >= Number(payload.dc);
      const damage = passed
        ? { margin: 0, fraction: 0, damage: 0 }
        : failureDamage(
          actor.system?.attributes?.hp?.max,
          total,
          payload.dc,
          config.damageCap,
          actor.system?.attributes?.hp?.value
        );
      const details = {
        actorName: actor.name,
        actorUuid: actor.uuid,
        checkId,
        actorImg: actor.img || "icons/svg/mystery-man.svg",
        dc: payload.dc,
        total,
        passed,
        margin: damage.margin,
        damage: damage.damage,
        damagePercent: Math.round(damage.fraction * 100),
        passive: preview.passive,
        passiveEntries: preview.passiveEntries,
        activeBonus: activePlan.bonus,
        slotBonus: slotPlan.bonus,
        situational,
        totalModifier
      };
      await ChatMessage.create({
        content: renderParticipantResult(details, false),
        speaker: ChatMessage.getSpeaker({ actor }),
        rolls: [roll],
        flags: {
          [MODULE_ID]: {
            type: "participant-submission",
            runId: payload.runId,
            checkId,
            actorUuid: actor.uuid,
            promptId: prompt.id,
            details
          }
        }
      });
      removeOpenCheckButton(checkId);
      await this.close();
    } finally {
      inFlight.delete(lockKey);
    }
  }

  _activeSpendPlan(actor, options) {
    let bonus = 0;
    const updates = [];
    for (const option of options) {
      const input = this.element.querySelector(`[name="active-${CSS.escape(option.itemId)}"]`);
      const rawCount = numberValue(input?.value ?? 0, `${option.name} uses`);
      if (!Number.isInteger(rawCount)) throw new Error(`${option.name} uses must be a whole number.`);
      const count = rawCount;
      if (count < 0 || count > option.available) throw new Error(`Invalid number of ${option.name} uses.`);
      if (count === 0) continue;

      const item = actor.items.get(option.itemId);
      const current = itemUses(item);
      if (!item || count > current.available) throw new Error(`${option.name} no longer has enough uses available.`);
      const updateValue = current.updatePath === "system.uses.spent"
        ? current.current + count
        : current.current - count;
      updates.push({ _id: item.id, [current.updatePath]: updateValue });
      const itemBonus = count * option.bonusPerUse;
      bonus += itemBonus;
    }
    return { bonus, updates };
  }

  _slotSpendPlan(actor, slots, bonusesByLevel) {
    const spends = {};
    const updates = {};
    for (const slot of slots) {
      const input = this.element.querySelector(`[name="slot-${slot.level}"]`);
      const rawCount = numberValue(input?.value ?? 0, `Level ${slot.level} spell slots`);
      if (!Number.isInteger(rawCount)) throw new Error(`Level ${slot.level} spell slots must be a whole number.`);
      const count = rawCount;
      if (count < 0 || count > slot.available) throw new Error(`Invalid number of level ${slot.level} spell slots.`);
      if (count === 0) continue;
      const key = `spell${slot.level}`;
      const current = Math.max(0, Number(actor.system?.spells?.[key]?.value) || 0);
      if (count > current) throw new Error(`Not enough level ${slot.level} spell slots remain.`);
      spends[slot.level] = count;
      updates[`system.spells.${key}.value`] = current - count;
    }
    return { spends, updates, bonus: spellSlotBonus(spends, bonusesByLevel) };
  }
}

function renderParticipantResult(details, damageApplied) {
  const result = details.passed
    ? `<strong class="qb-check-outcome">SUCCESS</strong>`
    : `<strong class="qb-check-outcome">FAILED by ${details.margin}</strong>`;
  const signed = (value) => `${Number(value) >= 0 ? "+" : ""}${Number(value) || 0}`;
  const passiveBreakdown = [
    `${details.passive.abilityName} ${signed(details.passive.ability)}`,
    `CHA ${signed(details.passive.charisma)}`,
    `HP ${signed(details.passive.hp)}`,
    `AC ${signed(details.passive.armor)}`,
    ...details.passiveEntries.map((entry) => `${escapeHtml(entry.name)} ${signed(entry.bonus)}`)
  ].join(", ");
  const damage = details.passed
    ? "<div>Encounter check passed.</div>"
    : damageApplied
      ? `<div>Damage applied: ${details.damage} HP (${details.damagePercent}%).</div>`
      : details.damage > 0
        ? `<div>Damage penalty: ${details.damage} HP (${details.damagePercent}%). Awaiting GM application.</div>`
        : "<div>No damage to apply.</div>";
  return chatCard(
    `<header><img src="${escapeHtml(details.actorImg)}" alt="" /><h3>${escapeHtml(details.actorName)} vs DC ${details.dc}</h3></header>
     <div>Passive: ${signed(details.passive.total)} (${passiveBreakdown})</div>
     <div>Active: ${signed(details.activeBonus)} · Spell slots: ${signed(details.slotBonus)} · Situation: ${signed(details.situational)}</div>
     <div class="qb-check-roll">Roll <strong>${details.total}</strong> vs DC ${details.dc} · ${result}</div>${damage}`,
    details.passed ? "qb-check-success" : "qb-check-failure"
  );
}

async function cardAction(button) {
  const action = button.dataset.cardAction;
  if (action === "fate-roll") return submitFateRoll(button.dataset.runId, button.dataset.requestId, button.dataset.userId);
  if (action === "stealth-roll") return submitStealthRoll(button.dataset.runId, button.dataset.requestId, button.dataset.actorUuid, button.dataset.userId);
  if (action === "open-check") return openParticipantApplication(button.dataset.checkId);
  if (action === "apply-damage") return applyDamage(button.dataset.operationId);
}

async function submitFateRoll(runId, requestId, userId) {
  if (!game.user.isGM && game.user.id !== userId) {
    ui.notifications.warn("Only the selected player or a GM can make this Fate roll.");
    return;
  }
  const prompt = findMessageByFlag("fate-request", "requestId", requestId);
  const flag = prompt?.flags?.[MODULE_ID];
  if (!prompt || flag?.status !== "pending") throw new Error("This Fate roll is no longer pending.");
  const lockKey = `fate:${requestId}`;
  if (inFlight.has(lockKey)) return;
  inFlight.add(lockKey);
  try {
    const roll = await nativeD20(null, 0, "Quick Battles Fate d20");
    if (!roll) return;
    await ChatMessage.create({
      content: `<p>Fate d20: ${roll.total}</p>`,
      whisper: [...new Set([...gmUserIds(), game.user.id])],
      rolls: [roll],
      flags: { [MODULE_ID]: { type: "fate-submission", runId, requestId, userId: game.user.id } }
    });
  } finally {
    inFlight.delete(lockKey);
  }
}

async function submitStealthRoll(runId, requestId, actorUuid, userId) {
  const actor = await actorByUuid(actorUuid);
  if (!game.user.isGM && (game.user.id !== userId || !actor.testUserPermission(game.user, "OWNER"))) {
    ui.notifications.warn(`Only the assigned owner of ${actor.name} or a GM can make this Stealth check.`);
    return;
  }
  const prompt = findMessageByFlag("stealth-request", "requestId", requestId);
  if (!prompt || prompt.flags?.[MODULE_ID]?.status !== "pending") throw new Error("This Stealth check is no longer pending.");
  const lockKey = `stealth:${requestId}`;
  if (inFlight.has(lockKey)) return;
  inFlight.add(lockKey);
  try {
    const rolls = await actor.rollSkill(
      { skill: "ste" },
      {},
      {
        create: false,
        rollMode: "gmroll",
        data: { flavor: `Quick Battles · ${actor.name} Stealth check`, speaker: ChatMessage.getSpeaker({ actor }) }
      }
    );
    const roll = rolls?.[0];
    if (!roll) return;
    await ChatMessage.create({
      content: `<p>${escapeHtml(actor.name)} Stealth check: ${roll.total}</p>`,
      whisper: [...new Set([...gmUserIds(), game.user.id])],
      speaker: ChatMessage.getSpeaker({ actor }),
      rolls: [roll],
      flags: { [MODULE_ID]: { type: "stealth-submission", runId, requestId, actorUuid, userId: game.user.id } }
    });
  } finally {
    inFlight.delete(lockKey);
  }
}

async function openParticipantApplication(checkId) {
  const prompt = findMessageByFlag("check-prompt", "checkId", checkId);
  const payload = prompt?.flags?.[MODULE_ID];
  if (!payload || payload.status !== "pending" || findParticipantSubmission(checkId)) {
    removeOpenCheckButton(checkId);
    throw new Error("This participant check is no longer pending.");
  }
  const actor = await actorByUuid(payload.actorUuid);
  if (!game.user.isGM && !actor.testUserPermission(game.user, "OWNER")) {
    ui.notifications.warn(`You do not own ${actor.name}.`);
    return;
  }
  let application = participantApplications.get(checkId);
  if (!application) {
    application = new QuickBattlesApplication({
    id: `${MODULE_ID}-check-${checkId}`,
    mode: "participant",
    checkId
    });
    participantApplications.set(checkId, application);
  }
  await application.render({ force: true });
}

function handleIncomingPrompt(message) {
  const flag = message.flags?.[MODULE_ID];
  if (!flag) return;
  if (flag.type === "participant-submission") removeOpenCheckButton(flag.checkId);
  const recipients = Array.from(message.whisper ?? []);
  const privateMessage = recipients.length > 0;
  if (privateMessage && !recipients.some((recipient) => (recipient.id ?? recipient) === game.user.id)) return;

  if (flag.type === "fate-request" && !game.user.isGM && game.user.id === flag.userId) {
    submitFateRoll(flag.runId, flag.requestId, flag.userId).catch(notifyError);
  } else if (flag.type === "stealth-request") {
    submitStealthRoll(flag.runId, flag.requestId, flag.actorUuid, flag.userId).catch(notifyError);
  } else if (flag.type === "check-prompt") {
    openParticipantApplication(flag.checkId).catch(notifyError);
  }
}

async function processChatSubmission(message) {
  const activeGM = game.users.activeGM;
  if (!game.user.isGM || (activeGM && activeGM.id !== game.user.id)) return;
  const data = message.flags?.[MODULE_ID];
  if (!data) return;
  try {
    if (data.type === "fate-submission") await processFateSubmission(message, data);
    if (data.type === "stealth-submission") await processStealthSubmission(message, data);
    if (data.type === "participant-submission") await processParticipantSubmission(message, data);
  } catch (error) {
    notifyError(error);
  }
}

function submittedRoll(message) {
  return submittedRollTotal(message.rolls?.[0], (serialized) => Roll.fromJSON(serialized));
}

async function processFateSubmission(message, data) {
  const userId = chatMessageAuthorId(message);
  const submitter = game.users.get(userId);
  if (!submitter || userId !== data.userId) {
    if (!submitter?.isGM) {
      throw new Error("The Fate roll author does not match the selected player.");
    }
  }
  const current = await currentRun(data.runId);
  if (!current || current.run.fate.pace === "stealth") return;
  if (current.run.fate.requestId !== data.requestId) return;
  if (!submitter?.isGM && current.run.fate.selectedUserId !== userId) return;
  if (current.run.status === "fate-pending") {
    current.run.fate.d20 = submittedRoll(message);
    current.run.fate.submissionId = message.id;
    current.run.status = "fate-resolving";
    await persistRun(current.run, current.message);
  } else if (
    current.run.status !== "fate-resolving"
    || current.run.fate.submissionId !== message.id
  ) return;
  await finishFate(current.run, current.message);
}

async function processStealthSubmission(message, data) {
  const userId = chatMessageAuthorId(message);
  const actor = await actorByUuid(data.actorUuid);
  const submitter = game.users.get(userId);
  if (!submitter || (!submitter.isGM && !actor.testUserPermission(submitter, "OWNER"))) {
    throw new Error(`The submitter does not own ${actor.name}.`);
  }
  const current = await currentRun(data.runId);
  if (!current || !["fate-pending", "fate-resolving"].includes(current.run.status)
    || current.run.fate.pace !== "stealth") return;
  const request = current.run.fate.stealthRequests.find((entry) => entry.requestId === data.requestId);
  if (!request || request.actorUuid !== data.actorUuid) return;
  if (!submitter.isGM && request.userId !== userId) throw new Error("The Stealth request belongs to another player.");
  const isRecovery = current.run.status === "fate-resolving"
    && current.run.fate.submissionId === message.id
    && request.total != null;
  if (request.total != null && !isRecovery) return;
  if (!isRecovery) {
    request.total = submittedRoll(message);
    request.userId = userId;
    const prompt = game.messages.get(request.promptId);
    if (prompt) await prompt.delete();
  }
  if (current.run.fate.stealthRequests.every((entry) => entry.total != null)) {
    current.run.status = "fate-resolving";
    current.run.fate.submissionId = message.id;
    await persistRun(current.run, current.message);
    await finishFate(current.run, current.message);
  } else {
    await persistRun(current.run, current.message);
    mainApplication?.render();
  }
}

async function finishFate(run, message) {
  const config = await readConfig();
  const baseRoll = run.fate.pace === "stealth"
    ? averageRoundedDown(run.fate.stealthRequests.map((entry) => entry.total))
    : run.fate.d20;
  const paceModifier = run.fate.pace === "stealth" ? 0 : run.fate.paceModifier;
  const total = baseRoll + paceModifier + run.fate.situational + run.fate.campModifier;
  const failed = total < run.fate.dc;
  let difficulty = null;
  let threatType = null;
  let watchShift = null;
  if (failed) {
    const difficultyRoll = await new Roll("1d20").evaluate();
    difficulty = encounterBand(difficultyRoll.total, config.encounterDifficultyBands);
    threatType = (await new Roll("1d6").evaluate()).total;
    if (run.fate.situation === "camp") watchShift = (await new Roll("1d2").evaluate()).total;
  }

  const current = await currentRun(run.id);
  if (!current || current.run.status !== "fate-resolving"
    || current.run.fate.submissionId !== run.fate.submissionId) return;
  current.run.fateResult = {
    baseRoll,
    paceModifier,
    situational: run.fate.situational,
    campModifier: run.fate.campModifier,
    total,
    failed,
    label: failed ? "Threat detected" : "No threats",
    situation: run.fate.situation,
    showWatchShift: run.fate.situation === "camp" && watchShift != null,
    difficulty,
    threatType,
    watchShift
  };
  current.run.status = "fate-resolved";
  await persistRun(current.run, current.message ?? message);
  if (current.run.fate.promptId) {
    const prompt = game.messages.get(current.run.fate.promptId);
    if (prompt) {
      await prompt.update({
        content: chatCard(`<h3>Quick Battles · Fate check resolved</h3><p>${current.run.fateResult.label}: ${total} vs DC ${current.run.fate.dc}.</p>`),
        [`flags.${MODULE_ID}.status`]: "resolved"
      });
    }
  }
  if (config.postGmResults) {
    await ChatMessage.create({
      content: chatCard(`<h3>Fate result</h3><p>${current.run.fateResult.label}: ${total} vs DC ${current.run.fate.dc}.</p>${displayRollResult(current.run)}`),
      whisper: gmUserIds()
    });
  }
  mainApplication?.render();
}

async function processParticipantSubmission(message, data) {
  const userId = chatMessageAuthorId(message);
  const actor = await actorByUuid(data.actorUuid);
  const submitter = game.users.get(userId);
  if (!submitter || (!submitter.isGM && !actor.testUserPermission(submitter, "OWNER"))) {
    throw new Error(`The submitter does not own ${actor.name}.`);
  }
  const current = await currentRun(data.runId);
  if (!current || current.run.status !== "checks-pending") return;
  const check = current.run.checks[data.actorUuid];
  if (!check || check.checkId !== data.checkId) return;
  if (check.status === "pending") {
    check.status = "processing";
    check.submissionId = message.id;
    await persistRun(current.run, current.message);
  } else if (check.status !== "processing" || check.submissionId !== message.id) return;
  const total = submittedRoll(message);
  const details = data.details;
  const passed = total >= Number(current.run.selectedEncounter.dc);
  const config = await readConfig();
  const damage = passed
    ? { margin: 0, fraction: 0, damage: 0 }
    : failureDamage(
      actor.system?.attributes?.hp?.max,
      total,
      current.run.selectedEncounter.dc,
      config.damageCap,
      actor.system?.attributes?.hp?.value
    );
  details.total = total;
  details.passed = passed;
  details.margin = damage.margin;
  details.damage = damage.damage;
  details.damagePercent = Math.round(damage.fraction * 100);
  details.dc = current.run.selectedEncounter.dc;
  await message.update({
    content: renderParticipantResult(details, false),
    [`flags.${MODULE_ID}.details`]: details
  });

  check.status = passed ? "passed" : "failed";
  check.statusLabel = passed ? `Passed (${total})` : `Failed (${total}) · ${damage.damage} HP`;
  check.resultMessageId = message.id;
  check.total = total;
  check.damage = damage.damage;
  check.damageApplied = false;

  const allResolved = Object.values(current.run.checks).every((entry) => ["passed", "failed"].includes(entry.status));
  if (allResolved) current.run.status = "checks-resolved";
  await persistRun(current.run, current.message);
  const prompt = game.messages.get(check.promptId);
  if (prompt) await prompt.delete();
  if (!passed && damage.damage > 0) await createDamageControl(current.run, actor, message, details);
  mainApplication?.render();
}

async function createDamageControl(run, actor, resultMessage, details) {
  const operationId = `${run.id}:${actor.uuid}:${details.checkId}`;
  if (findMessageByFlag("damage-control", "operationId", operationId)) return;
  const button = createButton("Apply damage once", "apply-damage", `data-operation-id="${escapeHtml(operationId)}"`);
  await ChatMessage.create({
    content: chatCard(`<h3>GM damage control · ${escapeHtml(actor.name)}</h3><p>Apply ${details.damage} damage (${details.damagePercent}% of max HP) for failure by ${details.margin}.</p>${button}`),
    whisper: gmUserIds(),
    flags: {
      [MODULE_ID]: {
        type: "damage-control",
        operationId,
        runId: run.id,
        actorUuid: actor.uuid,
        resultMessageId: resultMessage.id,
        damage: details.damage,
        status: "pending"
      }
    }
  });
}

async function applyDamage(operationId) {
  if (!game.user.isGM) throw new Error("Only a GM can apply damage.");
  const activeGM = game.users.activeGM;
  if (activeGM && activeGM.id !== game.user.id) {
    throw new Error("Only the active GM can apply damage.");
  }
  const control = findMessageByFlag("damage-control", "operationId", operationId);
  const payload = control?.flags?.[MODULE_ID];
  if (!payload) throw new Error("Damage control was not found.");
  if (payload.status === "applied") {
    await control.delete();
    ui.notifications.info("This damage has already been applied.");
    return;
  }
  if (damageInFlight.has(operationId)) return;
  damageInFlight.add(operationId);
  try {
    const actor = await actorByUuid(payload.actorUuid);
    const appliedIds = actor.getFlag(MODULE_ID, "appliedDamageIds") ?? [];
    if (appliedIds.includes(operationId)) {
      await control.update({ [`flags.${MODULE_ID}.status`]: "applied" });
      const priorResult = game.messages.get(payload.resultMessageId);
      if (priorResult) {
        const details = priorResult.flags?.[MODULE_ID]?.details;
        if (details) {
          await priorResult.update({
            content: renderParticipantResult(details, true),
            [`flags.${MODULE_ID}.damageApplied`]: true
          });
        }
      }
      const current = await currentRun(payload.runId);
      const check = current?.run.checks?.[payload.actorUuid];
      if (check && !check.damageApplied) {
        check.damageApplied = true;
        await persistRun(current.run, current.message);
      }
      await control.delete();
      return;
    }
    const currentHp = Math.max(0, Number(actor.system?.attributes?.hp?.value) || 0);
    const damage = capDamageAtOneHp(payload.damage, currentHp);
    const newHp = currentHp - damage;
    await actor.update({
      "system.attributes.hp.value": newHp,
      [`flags.${MODULE_ID}.appliedDamageIds`]: [...appliedIds, operationId]
    });
    await control.update({ [`flags.${MODULE_ID}.status`]: "applied" });
    const result = game.messages.get(payload.resultMessageId);
    if (result) {
      const details = result.flags?.[MODULE_ID]?.details;
      if (details) {
        details.damage = damage;
        const maxHp = Math.max(0, Number(actor.system?.attributes?.hp?.max) || 0);
        details.damagePercent = maxHp > 0 ? Math.round((damage / maxHp) * 100) : 0;
      }
      await result.update({
        content: renderParticipantResult(details, true),
        [`flags.${MODULE_ID}.damageApplied`]: true,
        ...(details ? { [`flags.${MODULE_ID}.details`]: details } : {})
      });
    }
    const current = await currentRun(payload.runId);
    const check = current?.run.checks?.[actor.uuid];
    if (check) {
      check.damageApplied = true;
      await persistRun(current.run, current.message);
    }
    await control.delete();
    ui.notifications.info(`${actor.name} takes ${damage} damage.`);
    mainApplication?.render();
  } finally {
    damageInFlight.delete(operationId);
  }
}

function bindChatActions() {
  if (document.body.dataset.quickBattlesBound) return;
  document.body.dataset.quickBattlesBound = "true";
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-card-action]");
    if (!button) return;
    event.preventDefault();
    cardAction(button).catch(notifyError);
  });
}

Hooks.once("init", registerModuleSettings);
Hooks.once("ready", () => {
  bindChatActions();
  loadCatalog().catch(notifyError);
  Hooks.on("renderChatMessage", hideSubmittedCheckAction);
  Hooks.on("createChatMessage", (message) => handleIncomingPrompt(message));
  Hooks.on("createChatMessage", (message) => {
    console.log('[skyy] hooked');
    enqueueSubmission(() => processChatSubmission(message));
  });
  if (game.user.isGM) {
    for (const message of Array.from(game.messages)) {
      if (["fate-submission", "stealth-submission", "participant-submission"].includes(message.flags?.[MODULE_ID]?.type)) {
        enqueueSubmission(() => processChatSubmission(message));
      }
    }
  }
  Hooks.on("chatMessage", (_log, message) => {
    if (message.trim().toLocaleLowerCase() !== "/quickbattles") return;
    openMainApplication().catch(notifyError);
    return false;
  });
});
