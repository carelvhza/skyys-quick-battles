export const ABILITY_ORDER = ["str", "dex", "int", "wis", "cha"];

const RATING_BONUSES = { Low: 1, Medium: 2, High: 3 };
const CATALOG_ALIASES = new Map([
  ["armor of hexes (hexblade)", "armor of hexes"],
  ["brutal critical", "brutal critical (1 die)"],
  ["dread ambusher (gloom stalker)", "dread ambusher"],
  ["eldritch mind (eldritch invocation)", "eldritch invocation: eldritch mind"],
  ["improved pact weapon", "eldritch invocation: improved pact weapon"],
  ["improved pact weapon (eldritch invocation)", "eldritch invocation: improved pact weapon"],
  ["lifedrinker", "eldritch invocation: lifedrinker"],
  ["lifedrinker (eldritch invocation)", "eldritch invocation: lifedrinker"],
  ["relentless hex", "eldritch invocation: relentless hex"],
  ["relentless hex (eldritch invocation)", "eldritch invocation: relentless hex"],
  ["sign of ill omen", "eldritch invocation: sign of ill omen"],
  ["sign of ill omen (eldritch invocation)", "eldritch invocation: sign of ill omen"],
  ["thirsting blade", "eldritch invocation: thirsting blade"],
  ["thirsting blade (eldritch invocation)", "eldritch invocation: thirsting blade"],
  ["great weapon fighting (fighting style)", "great weapon fighting"],
  ["fighting style: great weapon fighting", "great weapon fighting"],
  ["archery", "fighting style: archery"],
  ["hexblade's curse (hexblade)", "hexblade's curse"],
  ["iron mind (gloom stalker)", "iron mind"],
  ["pact of the blade", "pact boon: pact of the blade"],
  ["relentless avenger (vengeance)", "relentless avenger"],
  ["fell-handed", "fell handed"],
  ["totem spirit (crocodile)", "totem spirit: crocodile"],
  ["fey touched (misty step)", "fey touched: misty step"],
  ["fey touched (silvery barbs)", "fey touched: silvery barbs"]
]);

function catalogNameKey(name) {
  const key = String(name).trim().toLocaleLowerCase();
  return CATALOG_ALIASES.get(key) ?? key;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseCsvRow(line) {
  const cells = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }

  cells.push(cell.trim());
  if (quoted) throw new Error("Unterminated quoted field in feat catalog.");
  return cells;
}

export function parseFeatCatalog(csvText) {
  return String(csvText)
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      const cells = parseCsvRow(line);
      if (cells.length < 5) throw new Error(`Invalid feat catalog row ${index + 1}.`);

      const [name, type, rating, ...remaining] = cells;
      const category = remaining.pop();
      const description = remaining.join(", ");
      const bonus = RATING_BONUSES[rating];
      if (!name || !["Passive", "Active"].includes(type) || !bonus || !category) {
        throw new Error(`Invalid feat catalog values on row ${index + 1}.`);
      }

      return {
        id: name.toLocaleLowerCase(),
        name,
        type,
        rating,
        bonus,
        description,
        category
      };
    });
}

export function mergeCatalog(baseCatalog, overrides = []) {
  const entries = new Map(baseCatalog.map((entry) => [catalogNameKey(entry.name), { ...entry }]));

  for (const override of overrides) {
    if (!override || typeof override.name !== "string" || !override.name.trim()) {
      throw new Error("Every catalog override needs a feature name.");
    }
    const name = override.name.trim();
    const id = catalogNameKey(name);
    const canonicalName = [...baseCatalog, ...entries.values()]
      .find((entry) => catalogNameKey(entry.name) === id)?.name ?? name;
    if (override.disabled === true) {
      entries.delete(id);
      continue;
    }

    const existing = entries.get(id) ?? { id, name, description: "", category: "Custom" };
    const rating = override.rating ?? existing.rating ?? "Low";
    if (!RATING_BONUSES[rating] && override.bonus == null && override.bonusPerUse == null) {
      throw new Error(`Catalog entry "${name}" needs a Low, Medium, or High rating or an explicit bonus.`);
    }
    if (override.bonus != null && !Number.isFinite(Number(override.bonus))) {
      throw new Error(`Catalog entry "${name}" has an invalid bonus.`);
    }
    if (override.bonusPerUse != null && !Number.isFinite(Number(override.bonusPerUse))) {
      throw new Error(`Catalog entry "${name}" has an invalid per-use bonus.`);
    }
    const bonus = finiteNumber(override.bonus ?? override.bonusPerUse, RATING_BONUSES[rating] ?? 1);
    const type = override.type ?? existing.type ?? "Active";
    if (!["Passive", "Active"].includes(type)) {
      throw new Error(`Catalog entry "${name}" must be Passive or Active.`);
    }
    entries.set(id, {
      ...existing,
      ...override,
      id,
      name: canonicalName,
      type,
      rating,
      bonus,
      bonusPerUse: finiteNumber(override.bonusPerUse, bonus)
    });
  }

  return [...entries.values()];
}

export function reassignEncounterGroup(encounters, removedGroupId, replacementGroupId) {
  if (!replacementGroupId) throw new Error("A remaining encounter group is required.");
  return encounters.map((encounter) => {
    if (!Array.isArray(encounter.groups) || !encounter.groups.includes(removedGroupId)) return encounter;
    return {
      ...encounter,
      groups: [...new Set(encounter.groups.map((groupId) => (
        groupId === removedGroupId ? replacementGroupId : groupId
      )))]
    };
  });
}

export function highestAbility(abilities = {}) {
  return ABILITY_ORDER.reduce(
    (best, key) => {
      const modifier = finiteNumber(abilities[key]?.mod ?? abilities[key], 0);
      return modifier > best.modifier ? { key, modifier } : best;
    },
    { key: ABILITY_ORDER[0], modifier: finiteNumber(abilities[ABILITY_ORDER[0]]?.mod ?? abilities[ABILITY_ORDER[0]], 0) }
  );
}

export function calculatePassiveBonuses({ abilities = {}, ac = 0, catalogBonus = 0 } = {}) {
  const bestAbility = highestAbility(abilities);
  const armorClass = finiteNumber(ac, 0);
  const armorBonus = armorClass >= 22 ? 2
    : armorClass >= 19 ? 1
      : armorClass >= 16 ? 0
        : armorClass >= 14 ? -1
          : armorClass >= 12 ? -2
            : -3;
  const bonuses = {
    ability: bestAbility.modifier,
    abilityName: bestAbility.key.toUpperCase(),
    armor: armorBonus,
    catalog: finiteNumber(catalogBonus, 0)
  };
  bonuses.total = bonuses.ability + bonuses.armor + bonuses.catalog;
  return bonuses;
}

export function spellcastingBonus(items = []) {
  const fullCasters = new Set(["bard", "cleric", "druid", "sorcerer", "wizard"]);
  let fullLevels = 0;
  let warlockLevels = 0;
  for (const item of items) {
    if (item.type !== "class") continue;
    const identifier = String(item.system?.identifier || item.name || "").trim().toLowerCase();
    const levels = Math.max(0, Math.floor(finiteNumber(item.system?.levels, 0)));
    if (fullCasters.has(identifier)) fullLevels += levels;
    else if (identifier === "warlock") warlockLevels += levels;
  }
  return (fullLevels > 0 ? Math.max(1, Math.floor(fullLevels / 4)) : 0)
    + (warlockLevels > 0 ? Math.max(1, Math.floor(warlockLevels / 8)) : 0);
}

export function averageRoundedDown(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("At least one roll is required to calculate a group average.");
  }
  return Math.floor(values.reduce((sum, value) => sum + finiteNumber(value), 0) / values.length);
}

export function d20ModifierParts(modifier) {
  const value = finiteNumber(modifier, 0);
  return value === 0 ? [] : [String(value)];
}

export function submittedRollTotal(rollData, deserializeRoll) {
  const roll = typeof rollData === "string" ? deserializeRoll(rollData) : rollData;
  const total = Number(roll?.total);
  if (!roll || !Number.isFinite(total)) {
    throw new Error("The submitted message has no valid Foundry roll.");
  }
  return total;
}

export function isRunActive(run) {
  if (!run) return false;
  return run.status === "fate-pending"
    || run.status === "fate-resolving"
    || run.status === "checks-pending"
    || run.status === "encounter-selected"
    || (run.status === "fate-resolved" && run.fateResult?.failed === true);
}

export function spellSlotBonus(spends, bonusesByLevel = {}) {
  return Object.entries(spends).reduce((total, [level, count]) => {
    return total + Math.max(0, Math.floor(finiteNumber(count))) * finiteNumber(bonusesByLevel[level], 0);
  }, 0);
}

export function availableSpellSlots(spells = {}, bonusesByLevel = {}) {
  const slots = Array.from({ length: 9 }, (_, index) => {
    const level = index + 1;
    const key = `spell${level}`;
    const slot = spells[key];
    const capacity = Math.max(0, finiteNumber(slot?.max ?? slot?.override, 0));
    if (capacity === 0) return null;
    return {
      level,
      capacity,
      available: Math.min(capacity, Math.max(0, finiteNumber(slot?.value, 0))),
      bonus: finiteNumber(bonusesByLevel[level], 0),
      resources: [{
        key,
        capacity,
        current: Math.max(0, finiteNumber(slot?.value, 0)),
        available: Math.min(capacity, Math.max(0, finiteNumber(slot?.value, 0)))
      }]
    };
  }).filter(Boolean);

  const pact = spells.pact;
  const pactLevel = Math.floor(finiteNumber(pact?.level, 0));
  const pactCapacity = Math.max(0, finiteNumber(pact?.max ?? pact?.override, 0));
  if (pactLevel >= 1 && pactLevel <= 9 && pactCapacity > 0) {
    let slot = slots.find((entry) => entry.level === pactLevel);
    if (!slot) {
      slot = {
        level: pactLevel,
        capacity: 0,
        available: 0,
        bonus: finiteNumber(bonusesByLevel[pactLevel], 0),
        resources: []
      };
      slots.push(slot);
    }
    const current = Math.max(0, finiteNumber(pact.value, 0));
    const available = Math.min(pactCapacity, current);
    slot.capacity += pactCapacity;
    slot.available += available;
    slot.resources.push({
      key: "pact",
      capacity: pactCapacity,
      current,
      available
    });
  }

  return slots.sort((left, right) => left.level - right.level);
}

export function spellSlotSpendPlan(spells = {}, spends = {}, bonusesByLevel = {}) {
  const availableByLevel = new Map(availableSpellSlots(spells).map((slot) => [slot.level, slot]));
  const updates = {};
  const validSpends = {};

  for (const [rawLevel, rawCount] of Object.entries(spends)) {
    const level = Number(rawLevel);
    const count = Number(rawCount);
    if (!Number.isInteger(level) || level < 1 || level > 9 || !Number.isInteger(count) || count < 0) {
      throw new Error("Spell-slot spends must use whole-number levels and counts.");
    }
    if (count === 0) continue;

    const slot = availableByLevel.get(level);
    if (!slot || count > slot.available) {
      throw new Error(`Not enough level ${level} spell slots remain.`);
    }

    let remaining = count;
    for (const resource of slot.resources) {
      const spent = Math.min(remaining, resource.available);
      if (spent === 0) continue;
      updates[`system.spells.${resource.key}.value`] = resource.current - spent;
      remaining -= spent;
    }
    if (remaining > 0) throw new Error(`Not enough level ${level} spell slots remain.`);
    validSpends[level] = count;
  }

  return {
    spends: validSpends,
    updates,
    bonus: spellSlotBonus(validSpends, bonusesByLevel)
  };
}

export function resourceBonus(entries = []) {
  return entries.reduce((total, entry) => {
    return total + Math.max(0, Math.floor(finiteNumber(entry.count))) * finiteNumber(entry.bonusPerUse);
  }, 0);
}

export function activeUseCount(entries = []) {
  return entries.reduce((total, entry) => {
    return total + Math.max(0, Math.floor(finiteNumber(entry.count)));
  }, 0);
}

export function validateActiveUseLimit(count, limit) {
  const maximum = Number(limit);
  if (!Number.isInteger(maximum) || maximum < 0) {
    throw new Error("The maximum number of active feats or spells must be a non-negative whole number.");
  }
  if (count > maximum) {
    throw new Error(`Choose no more than ${maximum} active feats or spells.`);
  }
  return count;
}

export function chatMessageAuthorId(message) {
  const author = message?.author;
  if (typeof author === "string") return author;
  return author?.id ?? author?._id ?? message?.user?.id ?? message?.user ?? null;
}

export function encounterBand(roll, bands) {
  const value = Math.floor(finiteNumber(roll, -1));
  const band = bands.find(({ min, max }) => value >= min && value <= max);
  if (!band) throw new Error(`Encounter roll ${value} does not match a configured difficulty band.`);
  return band;
}

export function capDamageAtOneHp(damage, currentHp, keepOneHp = true) {
  const requestedDamage = Math.max(0, Math.floor(finiteNumber(damage, 0)));
  const availableDamage = Math.max(0, Math.floor(finiteNumber(currentHp, 0)) - (keepOneHp ? 1 : 0));
  return Math.min(requestedDamage, availableDamage);
}

export function failureDamage(maxHp, total, dc, damagePerPoint, cap = 1, currentHp = maxHp, keepOneHp = true) {
  const margin = Math.max(0, Math.floor(finiteNumber(dc) - finiteNumber(total)));
  const maxHitPoints = Math.max(0, finiteNumber(maxHp));
  const maxFraction = Math.min(1, Math.max(0, finiteNumber(cap, 1)));
  const rate = Number(damagePerPoint);
  if (!Number.isInteger(rate) || rate < 0) throw new Error("Damage per DC point must be a non-negative whole number.");
  const calculatedDamage = Math.min(margin * rate, Math.floor(maxHitPoints * maxFraction));
  const damage = capDamageAtOneHp(calculatedDamage, currentHp, keepOneHp);
  return {
    margin,
    fraction: maxHitPoints > 0 ? damage / maxHitPoints : 0,
    damage
  };
}

export function itemUses(item) {
  const uses = item?.system?.uses;
  if (!uses) return { available: 0, updatePath: null, current: 0 };
  if (uses.spent != null && uses.max != null) {
    const maximum = Math.max(0, finiteNumber(uses.max));
    const spent = Math.max(0, finiteNumber(uses.spent));
    return {
      available: Math.max(0, maximum - spent),
      updatePath: "system.uses.spent",
      current: spent
    };
  }
  if (uses.value != null) {
    const current = Math.max(0, finiteNumber(uses.value));
    const maximum = Number(uses.max);
    return {
      available: Number.isFinite(maximum) ? Math.min(Math.max(0, maximum), current) : current,
      updatePath: "system.uses.value",
      current
    };
  }
  if (uses.max == null) return { available: 0, updatePath: null, current: 0 };
  return { available: Math.max(0, finiteNumber(uses.max)), updatePath: "system.uses.spent", current: 0 };
}

function getPathValue(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

export async function applyResourceUpdates(actor, itemUpdates = [], actorUpdates = {}) {
  const expectedActorUpdates = Object.entries(actorUpdates);
  let updatedActor = actor;

  if (expectedActorUpdates.length) {
    if (typeof actor?.update !== "function") {
      throw new Error("This actor cannot update spell-slot resources.");
    }
    updatedActor = (await actor.update({ ...actorUpdates })) ?? actor;
  }

  for (const update of itemUpdates) {
    const { _id, ...changes } = update;
    const item = updatedActor.items?.get(_id);
    if (typeof item?.update !== "function") {
      throw new Error(`This actor cannot update resource item ${_id}.`);
    }
    await item.update(changes);
  }

  for (const update of itemUpdates) {
    const item = updatedActor.items?.get(update._id);
    if (!item) throw new Error(`Could not verify resource updates for item ${update._id}.`);
    const changes = Object.entries(update).filter(([path]) => path !== "_id");
    if (changes.some(([path, expected]) => Number(getPathValue(item, path)) !== Number(expected))) {
      throw new Error(`The resource update for ${item.name} was not saved.`);
    }
  }
  for (const [path, expected] of expectedActorUpdates) {
    if (Number(getPathValue(updatedActor, path)) !== Number(expected)) {
      throw new Error(`The actor resource update at ${path} was not saved.`);
    }
  }
}

export function selectedCatalogBonuses(catalog, actorItems) {
  const passiveEntries = [];
  const activeEntries = [];
  const countedEntries = new Set();
  let passiveBonus = 0;

  for (const entry of catalog) {
    const key = catalogNameKey(entry.name);
    if (key === "fey touched") continue;
    if (countedEntries.has(key)) continue;
    const matches = actorItems.filter((item) => catalogNameKey(item.name) === key);
    const item = matches.find((candidate) => (
      candidate.name.trim().toLocaleLowerCase() === entry.name.trim().toLocaleLowerCase()
    )) ?? matches[0];
    if (!item) continue;
    countedEntries.add(key);

    if (entry.type === "Passive") {
      passiveBonus += finiteNumber(entry.bonus);
      passiveEntries.push({ name: entry.name, bonus: finiteNumber(entry.bonus) });
      continue;
    }

    const uses = itemUses(item);
    const isLayOnHands = entry.name.toLocaleLowerCase() === "lay on hands";
    const resourceCostPerUse = isLayOnHands ? 20 : 1;
    const available = Math.floor(uses.available / resourceCostPerUse);
    if (available > 0) {
      activeEntries.push({
        name: entry.name,
        bonusPerUse: isLayOnHands ? 1 : finiteNumber(entry.bonusPerUse ?? entry.bonus),
        available,
        ...(isLayOnHands ? { resourceCostPerUse, resourceAvailable: uses.available } : {}),
        updatePath: uses.updatePath,
        current: uses.current,
        itemId: item.id
      });
    }
  }

  return { passiveBonus, passiveEntries, activeEntries };
}
