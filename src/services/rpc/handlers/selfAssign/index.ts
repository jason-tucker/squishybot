/**
 * Barrel for the self-assign board verb handlers. Side-effect importing each
 * module registers its verb with the central registry — see
 * `src/services/rpc/registry.ts`. This barrel is imported once at boot
 * (from `bot/events/ready.ts`) so every handler is wired before the RPC
 * subscriber dispatches its first message.
 */
import './add'
import './update'
import './remove'
import './reorder'
import './setChannel'
import './publish'
