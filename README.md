# Skyy's Quick Battles

A lightweight Foundry VTT module for travel Fate checks, grouped encounter selection, and resource-powered D&D 5e 6.x participant checks. The module targets Foundry VTT 14, uses Foundry's native application and roll APIs, and adds no runtime dependencies.

## Open the GM window

Enable the module, then open the Quick Battles window as a GM with `/quickbattles` in chat or `Shift+Alt+B`. Type the slash command exactly as shown; `quickbattle,s` is not a registered command. The window stays open as Fate, encounter, and participant stages progress.

## Configure players and encounters

In Foundry, open **Game Settings → Configure Settings → Module Settings → Quick Battles configuration → Configure**. The responsive GM-only editor is organized as player characters, encounter groups, encounters, difficulty bands, then the remaining settings. It lets you manage player-to-actor mappings, encounter details and GM enemy rosters, Fate DCs, travel and spell-slot modifiers, damage behavior, and feature catalog changes. Configuration is shared across GM profiles in the world. A GM mapping may use any character or NPC; a player mapping lists only characters owned by that player. Long actor lists are scrollable. Encounters can belong to multiple groups, selected from the group-name dropdown; their stable IDs remain internal. The first group is named **Main** on a new or empty configuration. Removing a group linked to encounters asks for confirmation and transfers those links to the first remaining group.

The Quick Battles window remembers the last Fate area and encounter group selected on that client. Active run state is stored in the world settings for recovery without an extra GM-only run chat card. A GM can cancel a pending or selected run from the window and start a fresh Fate check.

Use the player dropdown to add a mapping, then choose an actor owned by that player. Encounter cards show the encounter name and group memberships; **Configure** opens a dialog for its description, optional DC/label overrides, and GM-only enemy roster. Roster counts do not modify encounter difficulty. Difficulty bands must cover d20 results 1–20 contiguously. Feature catalog cards can change a feature's description, type, or bonus, disable a default entry by name, or add a custom feature; Low/Medium/High ratings map to +1/+2/+3.

## Defaults

- Fate area DCs: 10 / 13 / 16; camp +3; fast/regular/slow pace -2 / 0 / +2; situational modifier 0.
- A failed Fate check rolls a d20 for encounter difficulty. The default bands preserve the original macro's 40% / 40% / 10% / 10% distribution: 1–8 DC 18, 9–16 DC 23, 17–18 DC 28, and 19–20 Combat at DC 28. Each band is configurable.
- Passive participant bonuses are the highest STR/DEX/INT/WIS/CHA modifier (first wins ties), `ceil(CHA modifier / 2)`, `floor(current HP / 40)`, AC +1 at 19–21 / +2 at 22+, and matching catalogued passive features.
- Slot bonuses are +1 for levels 1–2, +2 for 3–5, +3 for 6–8, and +4 for level 9. The check lists only spell levels with positive D&D 5e slot capacity (`max` or an explicit `override`), including levels whose slots are all spent; the spendable count is the current `value`. Players choose any available feature uses and slots to spend; selected resources are consumed on submission through the actor's native item/slot data, regardless of outcome.
- Failure damage is `floor(max HP × min(cap, 5% × points below DC))`; the default cap is 100%. The active GM applies damage; the actor-side operation ID prevents duplicate application if the control is retried.
- Reward generation is not included until reward rules are supplied.

The Fate result and tactical roster are shown only to the GM. Recovery cards are permission-checked, player check prompts are private and removed after submission, and participant results are public with a separate GM-only damage control that is removed after damage is applied. The GM window presents the Fate/current run beside encounter and participant controls, and returns to a new Fate check after a run is resolved or cancelled. The supplied original macros are represented by module stages rather than copied inline styling or macro-name execution.
