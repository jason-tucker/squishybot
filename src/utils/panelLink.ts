import { ContainerBuilder, TextDisplayBuilder } from 'discord.js'
import { sep } from './cv2'
import { env } from '../config/env'

/**
 * Website ("botpanel") deep-link helpers. Slash command replies append a small
 * subtext line pointing the user at the web panel page where they can do the
 * same thing. The base URL is env-configurable (PANEL_BASE_URL) and falls back
 * to the production panel domain so links work out of the box.
 */
const DEFAULT_PANEL_BASE_URL = 'https://bots.tucker.host'

/** Panel base URL, trailing slash stripped. Falls back to the prod domain. */
export function panelBaseUrl(): string {
  const raw = env.PANEL_BASE_URL?.trim()
  return (raw && raw.length > 0 ? raw : DEFAULT_PANEL_BASE_URL).replace(/\/+$/, '')
}

/** Absolute panel URL for a path like "/squishy/voice". */
export function panelUrl(path: string): string {
  const base = panelBaseUrl()
  if (!path) return base
  return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`
}

/** Subtext markdown line: "-# 🌐 [label](https://…)". */
export function panelLinkLine(path: string, label = 'Do this on the website'): string {
  return `-# 🌐 [${label}](${panelUrl(path)})`
}

/** Standalone TextDisplay component carrying the link line (valid top-level CV2). */
export function panelLinkDisplay(path: string, label?: string): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(panelLinkLine(path, label))
}

/** Append a divider + link line to an existing container; returns it for chaining. */
export function appendPanelLink(container: ContainerBuilder, path: string, label?: string): ContainerBuilder {
  return container
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(panelLinkLine(path, label)))
}
