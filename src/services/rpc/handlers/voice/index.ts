/**
 * Barrel for the voice-control verb handlers. Side-effect importing each
 * module registers its verb with the central registry — see
 * `src/services/rpc/registry.ts`. This barrel is imported once at boot
 * (from `bot/events/ready.ts`) so every handler is wired before the RPC
 * subscriber dispatches its first message.
 */
import './rename'
import './lock'
import './hide'
import './disconnect'
import './transfer'
import './delete'
