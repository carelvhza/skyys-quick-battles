export const ABILITY_ORDER = ["str", "dex", "int", "wis", "cha"];

const RATING_BONUSES = { Low: 1, Medium: 2, High: 3 };

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
  const entries = new Map(baseCatalog.map((entry) => [entry.name.toLocaleLowerCase(), { ...entry }]));

  for (const override of overrides) {
    if (!override || typeof override.name !== "string" || !override.name.trim()) {
      throw new Error("Every catalog override needs a feature name.");
    }
    const name = override.name.trim();
    const id = name.toLocaleLowerCase();
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
      name,
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

export function calculatePassiveBonuses({ abilities = {}, currentHp = 0, ac = 0, catalogBonus = 0 } = {}) {
  const bestAbility = highestAbility(abilities);
  const armorClass = finiteNumber(ac, 0);
  const bonuses = {
    ability: bestAbility.modifier,
    abilityName: bestAbility.key.toUpperCase(),
    hp: Math.floor(finiteNumber(currentHp, 0) / 50),
    armor: armorClass >= 22 ? 2 : armorClass >= 19 ? 1 : 0,
    catalog: finiteNumber(catalogBonus, 0)
  };
  bonuses.total = bonuses.ability + bonuses.hp + bonuses.armor + bonuses.catalog;
  return bonuses;
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

export function capDamageAtOneHp(damage, currentHp) {
  const requestedDamage = Math.max(0, Math.floor(finiteNumber(damage, 0)));
  const availableDamage = Math.max(0, Math.floor(finiteNumber(currentHp, 0)) - 1);
  return Math.min(requestedDamage, availableDamage);
}

export function failureDamage(maxHp, total, dc, cap = 1, currentHp = maxHp) {
  const margin = Math.max(0, Math.floor(finiteNumber(dc) - finiteNumber(total)));
  const maxHitPoints = Math.max(0, finiteNumber(maxHp));
  const maxFraction = Math.min(1, Math.max(0, finiteNumber(cap, 1)));
  const fraction = Math.min(maxFraction, margin * 0.05);
  const calculatedDamage = Math.floor(maxHitPoints * fraction);
  const damage = capDamageAtOneHp(calculatedDamage, currentHp);
  return {
    margin,
    fraction: damage < calculatedDamage && maxHitPoints > 0 ? damage / maxHitPoints : fraction,
    damage
  };
}

export function itemUses(item) {
  const uses = item?.system?.uses;
  if (!uses) return { available: 0, updatePath: null, current: 0 };
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

  const maximum = Math.max(0, finiteNumber(uses.max));
  const spent = Math.max(0, finiteNumber(uses.spent));
  return {
    available: Math.max(0, maximum - spent),
    updatePath: "system.uses.spent",
    current: spent
  };
}

function getPathValue(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

export async function applyResourceUpdates(actor, itemUpdates = [], actorUpdates = {}) {
  for (const update of itemUpdates) {
    const { _id, ...changes } = update;
    const item = actor.items?.get(_id);
    if (typeof item?.update !== "function") {
      throw new Error(`This actor cannot update resource item ${_id}.`);
    }
    await item.update(changes);
  }
  if (Object.keys(actorUpdates).length) {
    if (typeof actor?.update !== "function") {
      throw new Error("This actor cannot update spell-slot resources.");
    }
    await actor.update(actorUpdates);
  }

  for (const update of itemUpdates) {
    const item = actor.items?.get(update._id);
    if (!item) throw new Error(`Could not verify resource updates for item ${update._id}.`);
    const changes = Object.entries(update).filter(([path]) => path !== "_id");
    if (changes.some(([path, expected]) => Number(getPathValue(item, path)) !== Number(expected))) {
      throw new Error(`The resource update for ${item.name} was not saved.`);
    }
  }
  for (const [path, expected] of Object.entries(actorUpdates)) {
    if (Number(getPathValue(actor, path)) !== Number(expected)) {
      throw new Error(`The actor resource update at ${path} was not saved.`);
    }
  }
}

export function selectedCatalogBonuses(catalog, actorItems) {
  const itemsByName = new Map(actorItems.map((item) => [item.name.toLocaleLowerCase(), item]));
  const passiveEntries = [];
  const activeEntries = [];
  let passiveBonus = 0;

  for (const entry of catalog) {
    const item = itemsByName.get(entry.name.toLocaleLowerCase());
    if (!item) continue;

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
