/**
 * Button handler for the self-assign role board.
 *
 * CustomId families:
 *   sar:role:{roleId}   — toggle a plain Discord role on the clicking member.
 *   sar:gview:{gameId}  — toggle a game's channel View access.
 *   sar:gping:{gameId}  — toggle a game's LFG ping role.
 *
 * All replies are ephemeral. Guard checks that the entry is still enabled so
 * a click on a stale board message is handled gracefully.
 */
import { type ButtonInteraction, MessageFlags } from 'discord.js'
import {
  isEnabledRoleEntry,
  isEnabledGameEntry,
} from '../../services/selfAssign'
import {
  getGame,
  resolvePrefs,
  setPref,
  matchedViewChannel,
  matchedPingRoleId,
  gameDefaultViewOn,
} from '../../services/games'
import { checkAssignableRole } from '../../utils/roleGuard'

const UNAVAILABLE = "That entry isn't available for self-assign anymore."

export async function handleSelfAssignButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: 'This only works in the server.', flags: MessageFlags.Ephemeral })
    return
  }

  const parts = interaction.customId.split(':')
  // parts[0] === 'sar', parts[1] === kind, parts[2] === id
  const kind = parts[1]
  const refId = parts[2]

  let member
  try {
    member = await interaction.guild.members.fetch(interaction.user.id)
  } catch {
    await interaction.reply({ content: '❌ Something went wrong updating your roles.', flags: MessageFlags.Ephemeral })
    return
  }

  // ── sar:role:{roleId} ────────────────────────────────────────────────────
  if (kind === 'role') {
    const roleId = refId
    if (!isEnabledRoleEntry(roleId)) {
      await interaction.reply({ content: UNAVAILABLE, flags: MessageFlags.Ephemeral })
      return
    }
    const verdict = checkAssignableRole(interaction.guild, roleId)
    if (!verdict.ok) {
      await interaction.reply({ content: "That role can't be self-assigned.", flags: MessageFlags.Ephemeral })
      return
    }
    const name = interaction.guild.roles.cache.get(roleId)?.name ?? 'role'
    try {
      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId, 'self-assign board')
        await interaction.reply({ content: `➖ Removed **${name}**.`, flags: MessageFlags.Ephemeral })
      } else {
        await member.roles.add(roleId, 'self-assign board')
        await interaction.reply({ content: `✅ You now have **${name}**.`, flags: MessageFlags.Ephemeral })
      }
    } catch {
      await interaction.reply({ content: '❌ Something went wrong updating your roles.', flags: MessageFlags.Ephemeral })
    }
    return
  }

  // ── sar:gview:{gameId} ───────────────────────────────────────────────────
  if (kind === 'gview') {
    const gameId = refId
    if (!isEnabledGameEntry(gameId)) {
      await interaction.reply({ content: UNAVAILABLE, flags: MessageFlags.Ephemeral })
      return
    }
    const game = getGame(gameId)
    if (!game) {
      await interaction.reply({ content: UNAVAILABLE, flags: MessageFlags.Ephemeral })
      return
    }
    if (!matchedViewChannel(interaction.guild, game)) {
      await interaction.reply({ content: "This game has no channel set up yet.", flags: MessageFlags.Ephemeral })
      return
    }
    try {
      const prefs = await resolvePrefs(interaction.guild, member)
      const cur = prefs.find(p => p.game.id === gameId)?.wantsView ?? false
      const res = await setPref(member, gameId, 'view', !cur, { editorDiscordId: member.id, mode: 'self' })
      if (!res.ok) {
        await interaction.reply({ content: '❌ Something went wrong updating your roles.', flags: MessageFlags.Ephemeral })
        return
      }
      await interaction.reply({
        content: res.wantsView
          ? `✅ You can now see **${game.name}**'s channel.`
          : `🙈 Hid **${game.name}**'s channel for you.`,
        flags: MessageFlags.Ephemeral,
      })
    } catch {
      await interaction.reply({ content: '❌ Something went wrong updating your roles.', flags: MessageFlags.Ephemeral })
    }
    return
  }

  // ── sar:gping:{gameId} ───────────────────────────────────────────────────
  if (kind === 'gping') {
    const gameId = refId
    if (!isEnabledGameEntry(gameId)) {
      await interaction.reply({ content: UNAVAILABLE, flags: MessageFlags.Ephemeral })
      return
    }
    const game = getGame(gameId)
    if (!game) {
      await interaction.reply({ content: UNAVAILABLE, flags: MessageFlags.Ephemeral })
      return
    }
    if (!matchedPingRoleId(interaction.guild, game)) {
      await interaction.reply({ content: "This game has no LFG ping role set up yet.", flags: MessageFlags.Ephemeral })
      return
    }
    try {
      const prefs = await resolvePrefs(interaction.guild, member)
      const curPref = prefs.find(p => p.game.id === gameId)
      const curPing = curPref?.wantsPing ?? false
      const curView = curPref?.wantsView ?? false
      const desired = !curPing

      if (desired && !gameDefaultViewOn() && !curView) {
        // Need to grant View first before we can enable pings (games.setPref
        // enforces view-required-for-ping in opt-in mode).
        await setPref(member, gameId, 'view', true, { editorDiscordId: member.id, mode: 'self' })
        await setPref(member, gameId, 'ping', true, { editorDiscordId: member.id, mode: 'self' })
        await interaction.reply({
          content: `✅ Enabled channel access and LFG pings for **${game.name}**.`,
          flags: MessageFlags.Ephemeral,
        })
      } else {
        const res = await setPref(member, gameId, 'ping', desired, { editorDiscordId: member.id, mode: 'self' })
        if (!res.ok) {
          await interaction.reply({ content: '❌ Something went wrong updating your roles.', flags: MessageFlags.Ephemeral })
          return
        }
        await interaction.reply({
          content: desired
            ? `🔔 LFG pings ON for **${game.name}**.`
            : `🔕 LFG pings OFF for **${game.name}**.`,
          flags: MessageFlags.Ephemeral,
        })
      }
    } catch {
      await interaction.reply({ content: '❌ Something went wrong updating your roles.', flags: MessageFlags.Ephemeral })
    }
    return
  }
}
