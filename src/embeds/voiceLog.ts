import {
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} from 'discord.js'
import type { ChannelLogRow } from '../services/voice/channelLog'

/** Emoji + phrasing for each log type. `actor` is a ready-to-render mention or
 *  a fallback like "Someone"; `detail` is the row's freeform payload. */
function formatEntry(row: ChannelLogRow): string {
  const actor = row.actorUserId ? `<@${row.actorUserId}>` : null
  const who = actor ?? 'Someone'
  const detail = row.detail ?? ''
  switch (row.type) {
    case 'created':        return `🎉 ${who} opened the channel`
    case 'join':           return `➡️ ${who} joined`
    case 'leave':          return `⬅️ ${who} left`
    case 'game_start':     return `🎮 ${who} started playing **${detail}**`
    case 'game_stop':      return `⏹️ ${who} stopped playing **${detail}**`
    case 'lock':           return `🔒 ${who} locked the channel`
    case 'unlock':         return `🔓 ${who} unlocked the channel`
    case 'hide':           return `🙈 ${who} hid the channel`
    case 'show':           return `👁️ ${who} made the channel visible`
    case 'rename':         return actor ? `✏️ ${actor} renamed the channel to **${detail}**` : `✏️ Channel renamed to **${detail}**`
    case 'auto_rename':    return `🏷️ Auto-named the channel to **${detail}**`
    case 'claim':          return `👤 ${who} claimed the channel`
    case 'owner_transfer': return `👑 ${who} became the owner`
    case 'host_add':       return `🛡️ ${who} was made a host`
    case 'host_remove':    return `🚫 ${who} was removed as a host`
    case 'auto_on':        return `✨ ${who} turned on Smart auto-naming`
    case 'auto_off':       return `🔕 ${who} turned off auto-naming`
    case 'randomize':      return `🎲 ${who} randomized the name to **${detail}**`
    default:               return `• ${who} — ${row.type}${detail ? ` (${detail})` : ''}`
  }
}

/**
 * Ephemeral 📜 Channel Log panel. `rows` are newest-first (as returned by
 * `listChannelLog`) and render newest-first with a relative timestamp per line
 * (`<t:N:R>` — unambiguous across any span, long-lived static channels
 * included). Lines are accumulated under a fixed budget so we never cut one
 * mid-token; if any don't fit, a trailing note says how many were hidden.
 */
export function buildChannelLogPayload(rows: ChannelLogRow[]) {
  // CV2 TextDisplay accepts up to 4000 chars; keep headroom for the trailing
  // truncation note and safe rendering.
  const BUDGET = 3800
  const lines: string[] = ['### 📜 Channel Log']

  if (rows.length === 0) {
    lines.push('_No activity logged yet._')
  } else {
    lines.push('_Most recent first._')
    let used = lines.join('\n').length
    let shown = 0
    for (const row of rows) {
      const sec = Math.floor(row.createdAt.getTime() / 1000)
      const line = `<t:${sec}:R> ${formatEntry(row)}`
      if (used + line.length + 1 > BUDGET) break  // stop before a mid-line cut
      lines.push(line)
      used += line.length + 1
      shown++
    }
    if (shown < rows.length) {
      const hidden = rows.length - shown
      lines.push(`_…${hidden} older ${hidden === 1 ? 'entry' : 'entries'} not shown._`)
    }
  }

  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join('\n')),
  )

  return {
    flags: MessageFlags.IsComponentsV2 as number,
    components: [container],
    // Never ping the users mentioned in the history (joins/leaves/hosts/etc).
    allowedMentions: { parse: [] as const },
  }
}
