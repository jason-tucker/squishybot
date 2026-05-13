/**
 * Barrel for the `discord.*` verb handlers — low-level Discord-resource
 * creators called by panel-side "+ Create" inline buttons when a games-row
 * link points at a deleted/missing entity. Each module side-effect-registers
 * its verb with the central registry; importing this barrel from
 * `bot/events/ready.ts` wires them all at boot.
 *
 * The higher-level `game.provision` verb (see ../games/provision.ts) calls
 * these via the same `guild.channels.create` / `guild.roles.create` paths
 * but isn't routed through the registry — it owns its own atomic
 * "create channel + two roles, rollback on failure" flow.
 */
import './create_role'
import './create_channel'
