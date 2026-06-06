/**
 * Render a portable MessageSpec to a discord.js Components-V2 message payload.
 *
 * Defensive by design: the panel validates specs with zod before they hit the
 * DB, but a hand-edited row or a future schema bump shouldn't crash the bot —
 * unknown node types are skipped and empty/invalid nodes are dropped (Discord
 * rejects empty text displays / action rows / media galleries outright).
 *
 * All user-authored text (text displays, section lines, button labels, URLs,
 * media/thumbnail descriptions) is run through `substitute()` so `{{vars}}`
 * and `{{when:R}}` timestamp tokens resolve at post time.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js'
import { logger } from '../logger'
import { substitute, type SubstitutionContext } from './variables'
import type {
  ActionRowSpec,
  ButtonSpec,
  ButtonStyleName,
  ContainerSpec,
  MessageSpec,
  SectionSpec,
  ThumbnailSpec,
} from './types'

const SUPPRESS_NOTIFICATIONS = 1 << 12 // MessageFlags.SuppressNotifications

const BUTTON_STYLE: Record<ButtonStyleName, ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
  // Link is handled separately (needs a URL, not a customId); present so the
  // lookup below is total over ButtonStyleName.
  link: ButtonStyle.Link,
}

export interface RenderResult {
  flags: number
  components: unknown[]
  allowedMentions: { parse: never[] }
}

function s(text: unknown, ctx: SubstitutionContext): string {
  return typeof text === 'string' ? substitute(text, ctx) : ''
}

/** Apply a unicode/custom emoji to a button, swallowing parse errors. */
function applyEmoji(btn: ButtonBuilder, emoji: string | undefined): void {
  if (!emoji) return
  try {
    btn.setEmoji(emoji)
  } catch {
    /* invalid emoji string — skip rather than throw */
  }
}

function buildButton(spec: ButtonSpec, ctx: SubstitutionContext): ButtonBuilder | null {
  const label = s(spec.label, ctx).slice(0, 80)
  if (spec.style === 'link') {
    const url = s(spec.url, ctx).trim()
    if (!/^https?:\/\//i.test(url)) return null
    const btn = new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url)
    if (label) btn.setLabel(label)
    applyEmoji(btn, spec.emoji)
    if (!label && !spec.emoji) return null
    return btn
  }
  const customId = (spec.customId ?? '').trim()
  if (!customId) return null
  const btn = new ButtonBuilder()
    .setStyle(BUTTON_STYLE[spec.style] ?? ButtonStyle.Secondary)
    .setCustomId(customId.slice(0, 100))
  if (label) btn.setLabel(label)
  applyEmoji(btn, spec.emoji)
  if (spec.disabled) btn.setDisabled(true)
  if (!label && !spec.emoji) return null
  return btn
}

function buildActionRow(
  spec: ActionRowSpec,
  ctx: SubstitutionContext,
): ActionRowBuilder<MessageActionRowComponentBuilder> | null {
  const buttons = (spec.components ?? [])
    .slice(0, 5)
    .map((b) => buildButton(b, ctx))
    .filter((b): b is ButtonBuilder => b !== null)
  if (buttons.length === 0) return null
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...buttons)
}

function buildSection(spec: SectionSpec, ctx: SubstitutionContext): SectionBuilder | null {
  const lines = (spec.content ?? [])
    .slice(0, 3)
    .map((line) => s(line, ctx))
    .filter((line) => line.trim().length > 0)
  if (lines.length === 0) return null

  const section = new SectionBuilder()
  section.addTextDisplayComponents(...lines.map((l) => new TextDisplayBuilder().setContent(l)))

  const acc = spec.accessory
  if (acc && acc.type === 'thumbnail') {
    const url = s((acc as ThumbnailSpec).url, ctx).trim()
    if (!/^https?:\/\//i.test(url)) return null // section requires a valid accessory
    const thumb = new ThumbnailBuilder().setURL(url)
    const desc = s((acc as ThumbnailSpec).description, ctx)
    if (desc) thumb.setDescription(desc.slice(0, 256))
    if ((acc as ThumbnailSpec).spoiler) thumb.setSpoiler(true)
    section.setThumbnailAccessory(thumb)
  } else if (acc && acc.type === 'button') {
    const btn = buildButton(acc as ButtonSpec, ctx)
    if (!btn) return null
    section.setButtonAccessory(btn)
  } else {
    return null // Discord requires an accessory on every section
  }
  return section
}

function buildContainer(spec: ContainerSpec, ctx: SubstitutionContext): ContainerBuilder | null {
  const container = new ContainerBuilder()
  if (typeof spec.accentColor === 'number' && Number.isFinite(spec.accentColor)) {
    container.setAccentColor(spec.accentColor & 0xffffff)
  }
  if (spec.spoiler) container.setSpoiler(true)

  let added = 0
  for (const child of spec.components ?? []) {
    switch (child?.type) {
      case 'text': {
        const content = s(child.content, ctx)
        if (content.trim().length === 0) break
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content.slice(0, 4000)))
        added++
        break
      }
      case 'section': {
        const section = buildSection(child, ctx)
        if (section) {
          container.addSectionComponents(section)
          added++
        }
        break
      }
      case 'separator': {
        const sep = new SeparatorBuilder()
          .setSpacing(child.spacing === 'large' ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small)
          .setDivider(child.divider !== false)
        container.addSeparatorComponents(sep)
        added++
        break
      }
      case 'media': {
        const items = (child.items ?? [])
          .slice(0, 10)
          .map((it) => {
            const url = s(it.url, ctx).trim()
            if (!/^https?:\/\//i.test(url)) return null
            const item = new MediaGalleryItemBuilder().setURL(url)
            const desc = s(it.description, ctx)
            if (desc) item.setDescription(desc.slice(0, 256))
            if (it.spoiler) item.setSpoiler(true)
            return item
          })
          .filter((it): it is MediaGalleryItemBuilder => it !== null)
        if (items.length > 0) {
          container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(...items))
          added++
        }
        break
      }
      case 'action_row': {
        const row = buildActionRow(child, ctx)
        if (row) {
          container.addActionRowComponents(row)
          added++
        }
        break
      }
      default:
        // Unknown child type — skip.
        break
    }
  }
  return added > 0 ? container : null
}

/**
 * Render a spec to a sendable payload. `extraRows` are appended after the spec
 * components (used by game night to attach the live RSVP / ownership / cancel
 * buttons that aren't part of the author-edited spec).
 */
export function renderMessageSpec(
  spec: MessageSpec,
  ctx: SubstitutionContext,
  extraRows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [],
): RenderResult {
  const components: unknown[] = []
  try {
    for (const top of spec?.components ?? []) {
      if (top?.type === 'container') {
        const c = buildContainer(top, ctx)
        if (c) components.push(c)
      } else if (top?.type === 'action_row') {
        const r = buildActionRow(top, ctx)
        if (r) components.push(r)
      }
    }
  } catch (err) {
    logger.warn(`msgspec render failed: ${(err as Error)?.message}`)
  }

  for (const row of extraRows) components.push(row)

  let flags = MessageFlags.IsComponentsV2 as number
  if (spec?.suppressNotifications) flags |= SUPPRESS_NOTIFICATIONS

  // Pings are always suppressed for scheduled posts — a future opt-in can relax
  // this per-spec. Mentions still render, they just don't notify.
  return { flags, components, allowedMentions: { parse: [] } }
}
