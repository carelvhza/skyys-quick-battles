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
  const charismaModifier = finiteNumber(abilities.cha?.mod ?? abilities.cha, 0);
  const armorClass = finiteNumber(ac, 0);
  const bonuses = {
    ability: bestAbility.modifier,
    abilityName: bestAbility.key.toUpperCase(),
    charisma: Math.ceil(charismaModifier / 2),
    hp: Math.floor(finiteNumber(currentHp, 0) / 40),
    armor: armorClass >= 22 ? 2 : armorClass >= 19 ? 1 : 0,
    catalog: finiteNumber(catalogBonus, 0)
  };
  bonuses.total = bonuses.ability + bonuses.charisma + bonuses.hp + bonuses.armor + bonuses.catalog;
  return bonuses;
}

export function averageRoundedDown(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("At least one roll is required to calculate a group average.");
  }
  return Math.floor(values.reduce((sum, value) => sum + finiteNumber(value), 0) / values.length);
}

export function spellSlotBonus(spends, bonusesByLevel = {}) {
  return Object.entries(spends).reduce((total, [level, count]) => {
    return total + Math.max(0, Math.floor(finiteNumber(count))) * finiteNumber(bonusesByLevel[level], 0);
  }, 0);
}

export function encounterBand(roll, bands) {
  const value = Math.floor(finiteNumber(roll, -1));
  const band = bands.find(({ min, max }) => value >= min && value <= max);
  if (!band) throw new Error(`Encounter roll ${value} does not match a configured difficulty band.`);
  return band;
}

export function failureDamage(maxHp, total, dc, cap = 1) {
  const margin = Math.max(0, Math.floor(finiteNumber(dc) - finiteNumber(total)));
  const maxHitPoints = Math.max(0, finiteNumber(maxHp));
  const maxFraction = Math.min(1, Math.max(0, finiteNumber(cap, 1)));
  const fraction = Math.min(maxFraction, margin * 0.05);
  return {
    margin,
    fraction,
    damage: Math.floor(maxHitPoints * fraction)
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
    if (uses.available > 0) {
      activeEntries.push({
        name: entry.name,
        bonusPerUse: finiteNumber(entry.bonusPerUse ?? entry.bonus),
        available: uses.available,
        updatePath: uses.updatePath,
        current: uses.current,
        itemId: item.id
      });
    }
  }

  return { passiveBonus, passiveEntries, activeEntries };
}
