/**
 * `cmd.squishy.rxnroles.create` — build a reaction-role message from the
 * panel-side builder UI.
 *
 * Params:
 *   ```ts
 *   {
 *     channelId: string,                // 15-25 digit Discord snowflake
 *     body: string,                     // message body (clamped at 2000 chars
 *                                       //   by the service layer)
 *     mappings: Array<{                 // 1..20 entries (capped — Discord
 *       emoji: string,                  //   itself rejects > 20 reactions
 *       roleId: string,                 //   per message)
 *     }>,
 *     isTemporary?: boolean,
 *     expiresInMinutes?: number,        // required when isTemporary is true,
 *                                       //   1..43200 (30 days)
 *   }
 *   ```
 *
 * On success the bot:
 *   1. Fetches the channel by ID (must be text-based).
 *   2. Posts `body` as a normal (non-ephemeral, mentions stripped) message.
 *   3. Reacts to that message with each mapping's emoji so users have a
 *      pre-seeded click target.
 *   4. Inserts the `reaction_role_messages` row + one
 *      `reaction_role_mappings` row per mapping, keyed by the new
 *      message ID.
 *   5. If `isTemporary`: stores `expires_at = now() + expiresInMinutes min`
 *      so the existing cleanup tick (`startReactionRoleCleanup`) handles
 *      the eventual teardown.
 *
 * Returns:
 *   `{ ok: true, data: { messageId, channelId } }` on success — the panel
 *   uses these to deep-link / refetch the read-only tab.
 *
 *   `{ ok: false, error: '<code>' }` on validation or runtime failure.
 *   Error codes: `bad-params`, `bad-channel`, `bad-channel-type`,
 *   `bad-mappings`, `bad-role`, `bad-expires`, `guild-mismatch`,
 *   `send-failed`, `db-write-failed`. The panel renders these as a friendly
 *   banner.
 *
 * Custom emoji: callers may pass either the raw unicode char ("🟢") or
 * the full `<:name:id>` / `<a:name:id>` Discord syntax. The latter is
 * narrowed to just the numeric ID before insert — same convention as
 * the in-bot modal flow in `interactions/sudoSettings.ts`.
 *
 * Validation parity with the in-bot Reaction Roles modal: we don't trust
 * the panel to have sanitized — the panel is just one of two callers.
 */
import type { TextChannel } from 'discord.js'
import { registerVerb, type VerbHandler } from '../../registry'
import { createReactionRoleMessage } from '../../../reactionRoles'
import { checkAssignableRole } from '../../../../utils/roleGuard'
import { logger } from '../../../logger'

const SNOWFLAKE_RE = /^\d{15,25}$/
const MAX_MAPPINGS = 20
const MIN_MAPPINGS = 1
// 30 days — matches the cap on the in-bot Reaction Roles modal so the
// two creation surfaces stay consistent.
const MAX_EXPIRES_MIN = 60 * 24 * 30

interface CreateParams {
  channelId: string
  body: string
  mappings: { emoji: string; roleId: string }[]
  isTemporary?: boolean
  expiresInMinutes?: number
}

function parseParams(raw: unknown): CreateParams | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'bad-params' }
  const o = raw as Record<string, unknown>

  const channelId = typeof o.channelId === 'string' ? o.channelId.trim() : ''
  if (!SNOWFLAKE_RE.test(channelId)) return { error: 'bad-channel' }

  const body = typeof o.body === 'string' ? o.body : ''
  if (body.trim() === '') return { error: 'bad-params' }

  if (!Array.isArray(o.mappings)) return { error: 'bad-mappings' }
  if (o.mappings.length < MIN_MAPPINGS || o.mappings.length > MAX_MAPPINGS) {
    return { error: 'bad-mappings' }
  }

  const mappings: { emoji: string; roleId: string }[] = []
  for (const m of o.mappings) {
    if (!m || typeof m !== 'object') return { error: 'bad-mappings' }
    const mm = m as Record<string, unknown>
    const emojiRaw = typeof mm.emoji === 'string' ? mm.emoji.trim() : ''
    const roleId = typeof mm.roleId === 'string' ? mm.roleId.trim() : ''
    if (!emojiRaw) return { error: 'bad-mappings' }
    if (!SNOWFLAKE_RE.test(roleId)) return { error: 'bad-mappings' }
    // Custom emojis in <a?:name:id> form → strip to just the numeric id
    // so the reaction-add path matches `MessageReaction.emoji.id`.
    const customMatch = emojiRaw.match(/<a?:[^:]+:(\d+)>/)
    mappings.push({ emoji: customMatch ? customMatch[1] : emojiRaw, roleId })
  }

  const isTemporary = Boolean(o.isTemporary)
  let expiresInMinutes: number | undefined
  if (isTemporary) {
    const n = Number(o.expiresInMinutes)
    if (!Number.isFinite(n) || n < 1 || n > MAX_EXPIRES_MIN) {
      return { error: 'bad-expires' }
    }
    expiresInMinutes = Math.floor(n)
  }

  return { channelId, body, mappings, isTemporary, expiresInMinutes }
}

export const rxnRolesCreateHandler: VerbHandler = async (params, ctx) => {
  const parsed = parseParams(params)
  if ('error' in parsed) return { ok: false, error: parsed.error }

  // Resolve the channel. We don't trust a cache hit alone — fetch so a
  // stale cache (channel deleted, perms revoked) surfaces as an error
  // instead of a confusing send failure later.
  let channel
  try {
    channel = await ctx.client.channels.fetch(parsed.channelId)
  } catch {
    return { ok: false, error: 'bad-channel' }
  }
  if (!channel || !('isTextBased' in channel) || !channel.isTextBased()) {
    return { ok: false, error: 'bad-channel-type' }
  }
  // Only guild text-ish channels: DMs / group DMs would also be
  // text-based but we never want a reaction-role message in a DM.
  if (!('guildId' in channel) || !channel.guildId) {
    return { ok: false, error: 'bad-channel-type' }
  }

  // SECURITY (H2): params validation only checked that each roleId is a
  // well-formed snowflake — not that it's *safe to grant*. A Redis-capable
  // caller could otherwise wire a reaction to a privileged/managed role and
  // self-assign it. Refuse to create the message unless every mapped role
  // passes the shared assignability guard. (The reaction grant sink in
  // `messageReaction.ts` re-checks too, but failing here gives the panel a
  // clean error instead of silently seeding a dead reaction.)
  const guild = (channel as TextChannel).guild
  for (const m of parsed.mappings) {
    const verdict = checkAssignableRole(guild, m.roleId)
    if (!verdict.ok) {
      logger.warn(`rxnroles.create: refusing non-assignable role ${m.roleId} (${verdict.reason})`)
      return { ok: false, error: 'bad-role', details: verdict.reason }
    }
  }

  const expiresAt = parsed.expiresInMinutes
    ? new Date(Date.now() + parsed.expiresInMinutes * 60_000)
    : null

  try {
    const cfg = await createReactionRoleMessage(
      channel as TextChannel,
      parsed.body,
      parsed.mappings,
      {
        expiresAt,
        // Wave 7b: the panel doesn't carry a Discord user identity in
        // the envelope yet — leave the audit field null. The panel
        // writes its own audit row keyed on the session actor, so the
        // "who did this" trail still exists, just split across the
        // two stores.
        createdByUserId: undefined,
      },
    )
    return {
      ok: true,
      data: { messageId: cfg.messageId, channelId: cfg.channelId },
    }
  } catch (err) {
    const msg = (err as Error).message
    logger.warn(`rxnroles.create failed: ${msg}`)
    // Distinguish DB vs send failure by message inspection — both throw
    // generic Errors but the send path goes through discord.js with
    // recognizable messages. Conservative default: treat unknown as
    // db-write so we never claim "Discord rejected" for a DB blip.
    if (/missing access|missing permissions|cannot send/i.test(msg)) {
      return { ok: false, error: 'send-failed', details: msg }
    }
    return { ok: false, error: 'db-write-failed', details: msg }
  }
}

registerVerb('rxnroles.create', rxnRolesCreateHandler)
