/**
 * Game-night flavour of a scheduled post: builds the live variable context
 * (host mention, RSVP counts/rosters, the event time as a Discord timestamp)
 * and the interactive RSVP / ownership / cancel button rows, then renders the
 * author's MessageSpec through the generic msgspec renderer.
 *
 * Shared by the scheduler (first post), the send-now RPC verb, and the RSVP
 * button handlers (re-render on every toggle) so the message stays consistent
 * no matter what triggered the update.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageActionRowComponentBuilder,
} from 'discord.js'
import { renderMessageSpec, type RenderResult } from '../msgspec/render'
import type { SubstitutionContext } from '../msgspec/variables'
import type { MessageSpec } from '../msgspec/types'
import type { ScheduledPostRow } from '../../db/schema/scheduledPosts'

export type Rsvp = 'in' | 'maybe' | 'out'
export type Ownership = 'has' | 'needs'

function asMap(v: unknown): Record<string, string> {
  return v && typeof v === 'object' ? (v as Record<string, string>) : {}
}

function mentionsFor(map: Record<string, string>, want: string): string[] {
  return Object.entries(map)
    .filter(([, val]) => val === want)
    .map(([id]) => `<@${id}>`)
}

/** Unix seconds for the event time: variables.eventAt → fireAt → now. */
function eventUnix(row: ScheduledPostRow): number {
  const vars = (row.variables ?? {}) as Record<string, unknown>
  const raw = typeof vars.eventAt === 'string' ? vars.eventAt : null
  const parsed = raw ? Date.parse(raw) : NaN
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000)
  if (row.fireAt) return Math.floor(new Date(row.fireAt).getTime() / 1000)
  return Math.floor(Date.now() / 1000)
}

export function buildGameNightContext(row: ScheduledPostRow): SubstitutionContext {
  const rsvps = asMap(row.rsvps)
  const ownership = asMap(row.ownership)
  const vars = (row.variables ?? {}) as Record<string, unknown>

  const joining = mentionsFor(rsvps, 'in')
  const might = mentionsFor(rsvps, 'maybe')
  const out = mentionsFor(rsvps, 'out')
  const needs = mentionsFor(ownership, 'needs')
  const has = mentionsFor(ownership, 'has')

  const summaryLines = [
    `✅ **Joining (${joining.length}):** ${joining.length ? joining.join(', ') : '_none yet_'}`,
    `🤔 **Might join (${might.length}):** ${might.length ? might.join(', ') : '_none_'}`,
    `❌ **Not joining (${out.length}):** ${out.length ? out.join(', ') : '_none_'}`,
  ]
  if (needs.length > 0) {
    summaryLines.push(`🛒 **Need a copy (${needs.length}):** ${needs.join(', ')}`)
  }

  return {
    values: {
      game: row.title ?? '',
      host: row.createdByDiscordId ? `<@${row.createdByDiscordId}>` : '',
      channel: `<#${row.channelId}>`,
      notes: typeof vars.notes === 'string' ? vars.notes : '',
      'count.in': String(joining.length),
      'count.maybe': String(might.length),
      'count.out': String(out.length),
      'count.needs': String(needs.length),
      'count.has': String(has.length),
      'list.in': joining.length ? joining.join(', ') : '_none yet_',
      'list.maybe': might.length ? might.join(', ') : '_none_',
      'list.out': out.length ? out.join(', ') : '_none_',
      'list.needs': needs.length ? needs.join(', ') : '_none_',
      rsvp: summaryLines.join('\n'),
    },
    timestamps: {
      when: eventUnix(row),
    },
  }
}

export function buildRsvpRows(
  postId: string,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const rsvpRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`sp:rsvp:in:${postId}`).setLabel('Joining').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`sp:rsvp:maybe:${postId}`).setLabel('Might join').setEmoji('🤔').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`sp:rsvp:out:${postId}`).setLabel('Not joining').setEmoji('❌').setStyle(ButtonStyle.Secondary),
  )
  const ownRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`sp:own:has:${postId}`).setLabel('I own it').setEmoji('👍').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`sp:own:needs:${postId}`).setLabel("I don't own it").setEmoji('🛒').setStyle(ButtonStyle.Secondary),
  )
  const cancelRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`sp:cancel:${postId}`).setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Danger),
  )
  return [rsvpRow, ownRow, cancelRow]
}

/** Build the full sendable payload for a scheduled post. */
export function buildScheduledPostPayload(row: ScheduledPostRow): RenderResult {
  const spec = row.spec as MessageSpec
  if (row.kind === 'game_night') {
    const ctx = buildGameNightContext(row)
    const extra = row.enableRsvp ? buildRsvpRows(row.id) : []
    return renderMessageSpec(spec, ctx, extra)
  }
  // Generic post — minimal context (just the event/when timestamp + channel).
  const ctx: SubstitutionContext = {
    values: { channel: `<#${row.channelId}>` },
    timestamps: { when: eventUnix(row) },
  }
  return renderMessageSpec(spec, ctx)
}
