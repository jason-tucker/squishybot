/**
 * Portable "message spec" — the JSON contract shared between the botpanel web
 * editor (author side) and this bot (render side).
 *
 * The panel validates with zod (web/src/lib/msgspec/schema.ts) before it ever
 * lands in the DB, so the renderer treats the shape as trusted-but-defensive:
 * unknown node types are skipped, missing fields fall back to safe defaults.
 *
 * Keep this in sync with web/src/lib/msgspec/schema.ts. The version field lets
 * us evolve the shape without breaking already-stored rows.
 */

export const MSGSPEC_VERSION = 1 as const

export type ButtonStyleName = 'primary' | 'secondary' | 'success' | 'danger' | 'link'
export type SeparatorSpacingName = 'small' | 'large'

export interface ButtonSpec {
  type: 'button'
  style: ButtonStyleName
  label?: string
  emoji?: string
  /** Required for `style: 'link'`. */
  url?: string
  /** Required for every non-link style. */
  customId?: string
  disabled?: boolean
}

export interface ThumbnailSpec {
  type: 'thumbnail'
  url: string
  description?: string
  spoiler?: boolean
}

export interface TextDisplaySpec {
  type: 'text'
  content: string
}

export interface SectionSpec {
  type: 'section'
  /** 1..3 text lines rendered stacked; the accessory floats to the right. */
  content: string[]
  accessory: ButtonSpec | ThumbnailSpec
}

export interface SeparatorSpec {
  type: 'separator'
  divider?: boolean
  spacing?: SeparatorSpacingName
}

export interface MediaItemSpec {
  url: string
  description?: string
  spoiler?: boolean
}

export interface MediaGallerySpec {
  type: 'media'
  items: MediaItemSpec[]
}

export interface ActionRowSpec {
  type: 'action_row'
  components: ButtonSpec[]
}

export type ContainerChildSpec =
  | TextDisplaySpec
  | SectionSpec
  | SeparatorSpec
  | MediaGallerySpec
  | ActionRowSpec

export interface ContainerSpec {
  type: 'container'
  /** 0xRRGGBB integer; null/undefined = no accent bar. */
  accentColor?: number | null
  spoiler?: boolean
  components: ContainerChildSpec[]
}

export type TopComponentSpec = ContainerSpec | ActionRowSpec

export interface MessageSpec {
  version: number
  suppressNotifications?: boolean
  components: TopComponentSpec[]
}

/** A minimal empty spec — one container with a single text line. */
export function emptySpec(): MessageSpec {
  return {
    version: MSGSPEC_VERSION,
    components: [
      {
        type: 'container',
        accentColor: 0x5865f2,
        components: [{ type: 'text', content: '' }],
      },
    ],
  }
}
