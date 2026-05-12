/**
 * /color — member-facing color role picker (#38). Minimal effort version:
 * Discord-managed select listing curated color roles. Picking one removes
 * any other color roles the member has and adds the chosen one.
 *
 * Gated by feature.color_roles (default OFF, toggle in /sudo → Settings →
 * Debug → Feature flags).
 */
import {
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
  ActionRowBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js'
import { db } from '../db/client'
import { colorRoles } from '../db/schema'
import { eq } from 'drizzle-orm'
import { getBoolSetting } from '../services/settings'
import { logger } from '../services/logger'

export const data = new SlashCommandBuilder()
  .setName('color')
  .setDescription('Pick a color role')

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!getBoolSetting('feature.color_roles', false)) {
    await interaction.reply({ content: 'ℹ️ Color roles are currently disabled.', ephemeral: true })
    return
  }
  const rows = await db.select().from(colorRoles).where(eq(colorRoles.guildId, interaction.guildId!))
  if (rows.length === 0) {
    await interaction.reply({ content: 'ℹ️ No color roles configured yet. Ask a sudo to add some.', ephemeral: true })
    return
  }

  const options = rows.slice(0, 25).map(r => ({ label: r.label.slice(0, 100), value: r.roleId, emoji: '🎨' }))
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('color:pick')
      .setPlaceholder('Pick a color…')
      .addOptions(options),
  )
  await interaction.reply({ content: 'Pick your color:', components: [row], ephemeral: true })
}

export async function handleColorPick(interaction: StringSelectMenuInteraction): Promise<void> {
  const picked = interaction.values[0]
  if (!picked) return
  await interaction.deferUpdate()
  const member = await interaction.guild!.members.fetch(interaction.user.id)
  const rows = await db.select().from(colorRoles).where(eq(colorRoles.guildId, interaction.guildId!))
  const colorRoleIds = new Set(rows.map(r => r.roleId))

  // Remove any other curated color roles the member currently has.
  for (const id of member.roles.cache.keys()) {
    if (colorRoleIds.has(id) && id !== picked) {
      await member.roles.remove(id, '/color swap').catch(err => logger.warn(`/color: remove ${id} failed: ${(err as Error).message}`))
    }
  }
  await member.roles.add(picked, '/color pick').catch(err => logger.warn(`/color: add ${picked} failed: ${(err as Error).message}`))

  await interaction.editReply({ content: `✅ Color set to <@&${picked}>.`, components: [] })
}
