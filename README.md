# Skyy's Quick Battles

A lightweight Foundry VTT module for travel Fate checks, grouped encounter selection, and resource-powered D&D 5e 6.x participant checks. The module targets Foundry VTT 14, uses Foundry's native application and roll APIs, and adds no runtime dependencies.

## Open the GM window

Enable the module, then open the Quick Battles window as a GM with `/quickbattles` in chat or `Shift+Alt+B`. The window stays open as Fate, encounter, and participant stages progress.

## Configure players and encounters

Open **Edit configuration** in the GM window. Configuration is JSON stored in the current GM user's Foundry setting; each GM profile must configure its own values. Player cards receive only the check data they need. A minimal configuration looks like:

```json
{
  "players": [
    { "userId": "USER_ID", "actorUuid": "Actor.ACTOR_ID" }
  ],
  "encounterGroups": [
    { "id": "forest", "name": "Forest" }
  ],
  "encounters": [
    {
      "id": "forest-ambush",
      "name": "Forest ambush",
      "description": "A brief player-facing description.",
      "groups": ["forest"],
      "roster": [
        { "actorId": "NPC_ACTOR_ID", "count": 2 }
      ]
    }
  ]
}
```

Use Foundry user IDs and actor UUIDs for the configured player-to-main-character mapping. An encounter can list more than one group. Its `roster` is GM-only and is used as tactical build guidance; counts do not modify encounter difficulty. The participant checklist defaults to configured main characters, and the GM can add other character/NPC actors for that run.

The same configuration object accepts `fateDcs`, `campBonus`, `paceModifiers`, `spellSlotBonuses`, `encounterDifficultyBands`, `damageCap`, and `postGmResults` to adjust the defaults below. Difficulty bands must cover d20 results 1–20 contiguously; each band has `min`, `max`, `label`, and `dc`.

The complete default feature allowlist is included in `data/feat-catalog.csv` from the supplied 384-row catalog. Only matching catalog entries contribute passive bonuses or appear as active resources; Low/Medium/High map to +1/+2/+3. Add `catalogOverrides` to the JSON to replace an entry by name, add a custom entry, or disable a default:

```json
{
  "catalogOverrides": [
    { "name": "Custom Feature", "type": "Active", "rating": "Medium", "bonusPerUse": 2 },
    { "name": "Alert", "disabled": true }
  ]
}
```

## Defaults

- Fate area DCs: 10 / 13 / 16; camp +3; fast/regular/slow pace -2 / 0 / +2; situational modifier 0.
- A failed Fate check rolls a d20 for encounter difficulty. The default bands preserve the original macro's 40% / 40% / 10% / 10% distribution: 1–8 DC 18, 9–16 DC 23, 17–18 DC 28, and 19–20 Combat at DC 28. Each band is configurable.
- Passive participant bonuses are the highest STR/DEX/INT/WIS/CHA modifier (first wins ties), `ceil(CHA modifier / 2)`, `floor(current HP / 40)`, AC +1 at 19–21 / +2 at 22+, and matching catalogued passive features.
- Slot bonuses are +1 for levels 1–2, +2 for 3–5, +3 for 6–8, and +4 for level 9. Players choose any available feature uses and slots to spend; selected resources are consumed on submission through the actor's native item/slot data, regardless of outcome.
- Failure damage is `floor(max HP × min(cap, 5% × points below DC))`; the default cap is 100%. Applying damage is GM-only and records an actor-side operation ID to prevent duplicate application.
- Reward generation is not included until reward rules are supplied.

The Fate result and tactical roster are shown only to the GM. Recovery cards are permission-checked, player check prompts are private, and participant results are public with a separate GM-only damage control. The supplied original macros are represented by module stages rather than copied inline styling or macro-name execution.
