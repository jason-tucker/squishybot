/**
 * One-time owner DM pitching the (opt-in, default-OFF) Activity Stats
 * feature. Fires once from src/bot/events/ready.ts after boot; gated on
 * `stats.owner_prompted` so it never repeats, and skipped entirely once the
 * feature is already on (nothing to pitch at that point).
 */
import { ContainerBuilder, MessageFlags, TextDisplayBuilder } from 'discord.js'
import type { Client } from 'discord.js'
import { env } from '../../config/env'
import { sep } from '../../utils/cv2'
import { panelUrl } from '../../utils/panelLink'
import { logger } from '../logger'
import { getBoolSetting, getSetting, setSetting } from '../settings'

export async function maybePromptOwnerForStats(client: Client): Promise<void> {
  try {
    if (getBoolSetting('feature.activity_stats', false)) return
    if (getSetting('stats.owner_prompted') === 'true') return
    if (!env.BOT_OWNER_ID) return

    const owner = await client.users.fetch(env.BOT_OWNER_ID).catch(() => null)
    if (owner) {
      const container = new ContainerBuilder()
        .setAccentColor(0x5865f2)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 📊 Activity Stats is available'))
        .addSeparatorComponents(sep())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          'A new opt-in feature can log per-user message, emoji, voice, and game '
          + 'activity so the panel can show heatmaps and leaderboards.\n\n'
          + '**Never stored:** message content. **Stored:** counts + voice-session '
          + 'timestamps only.',
        ))
        .addSeparatorComponents(sep())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `**Enable it:** \`/sudo\` → Settings → 📊 Activity Stats, or on the panel: ${panelUrl('/squishy/stats')}`,
        ))

      // Unlike the silent boot DM in ready.ts, this one is worth noticing —
      // deliberately NOT setting SuppressNotifications.
      await owner.send({
        flags: MessageFlags.IsComponentsV2 as number,
        components: [container],
      } as any).catch(err => logger.warn(`activity: owner prompt DM failed: ${(err as Error).message}`))
    }

    await setSetting('stats.owner_prompted', 'true', undefined, { audit: false })
  } catch (err) {
    logger.warn(`activity: maybePromptOwnerForStats failed: ${(err as Error).message}`)
  }
}
