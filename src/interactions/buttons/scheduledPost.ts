/**
 * Live button handlers for posted scheduled game-night messages.
 *
 * customId families (`sp:` = scheduled post):
 *   sp:rsvp:{in|maybe|out}:{postId}   — toggle the clicker's RSVP
 *   sp:own:{has|needs}:{postId}       — toggle "I own / need a copy"
 *   sp:cancel:{postId}                — host (creator) or sudo cancels
 *
 * Unlike the legacy in-memory `/sudo → Game Night` flow, state lives in the
 * `scheduled_posts` row (rsvps / ownership JSON), so toggles survive restarts.
 */
import {
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type ButtonInteraction,
} from 'discord.js'
import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { scheduledPosts, type ScheduledPostRow } from '../../db/schema/scheduledPosts'
import { isSudo } from '../../services/voice/permissions'
import { buildScheduledPostPayload, type Ownership, type Rsvp } from '../../services/scheduledPosts/gameNight'
import { logger } from '../../services/logger'

function asMap(v: unknown): Record<string, string> {
  return v && typeof v === 'object' ? { ...(v as Record<string, string>) } : {}
}

async function loadRow(id: string): Promise<ScheduledPostRow | null> {
  const [row] = await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, id))
  return row ?? null
}

export async function handleScheduledPostButton(interaction: ButtonInteraction): Promise<void> {
  const parts = interaction.customId.split(':') // sp:rsvp:in:{id} | sp:own:has:{id} | sp:cancel:{id}
  const kind = parts[1]

  if (kind === 'cancel') {
    await handleCancel(interaction, parts[2])
    return
  }

  const state = parts[2]
  const id = parts[3]
  const row = await loadRow(id)
  if (!row || row.status === 'canceled') {
    await interaction.reply({ content: '❌ This Game Night is no longer active.', ephemeral: true })
    return
  }

  const userId = interaction.user.id
  if (kind === 'rsvp') {
    const rsvps = asMap(row.rsvps)
    if (rsvps[userId] === state) delete rsvps[userId]
    else rsvps[userId] = state as Rsvp
    row.rsvps = rsvps
    await db.update(scheduledPosts).set({ rsvps, updatedAt: new Date() }).where(eq(scheduledPosts.id, id))
  } else if (kind === 'own') {
    const ownership = asMap(row.ownership)
    if (ownership[userId] === state) delete ownership[userId]
    else ownership[userId] = state as Ownership
    row.ownership = ownership
    await db.update(scheduledPosts).set({ ownership, updatedAt: new Date() }).where(eq(scheduledPosts.id, id))
  } else {
    return
  }

  // Re-render in place from the freshly-mutated row.
  await interaction.update(buildScheduledPostPayload(row) as never)
}

async function handleCancel(interaction: ButtonInteraction, id: string): Promise<void> {
  const row = await loadRow(id)
  if (!row) {
    await interaction.reply({ content: '⌛ This Game Night no longer exists.', ephemeral: true }).catch(() => {})
    return
  }
  const member = interaction.guild ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null) : null
  const allowed = interaction.user.id === row.createdByDiscordId || (member ? isSudo(member) : false)
  if (!allowed) {
    await interaction.reply({ content: '❌ Only the host or a sudo user can cancel this Game Night.', ephemeral: true })
    return
  }

  await db
    .update(scheduledPosts)
    .set({ status: 'canceled', updatedAt: new Date() })
    .where(eq(scheduledPosts.id, id))
    .catch(() => {})

  try {
    await interaction.message.delete()
  } catch {
    await interaction
      .update({
        flags: MessageFlags.IsComponentsV2 as number,
        components: [
          new ContainerBuilder()
            .setAccentColor(0xed4245)
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(`❌ Game Night cancelled by <@${interaction.user.id}>.`),
            ),
        ],
        allowedMentions: { parse: [] as never[] },
      } as never)
      .catch(() => {})
  }
  logger.info(`scheduledPost cancel id=${id} by=${interaction.user.id}`)
}
