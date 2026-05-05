import type { autoChannels, hubChannels } from '../db/schema'
import type { InferSelectModel } from 'drizzle-orm'

export type AutoChannelRecord = InferSelectModel<typeof autoChannels>
export type HubChannelRecord = InferSelectModel<typeof hubChannels>

export type VoiceAction =
  | 'delete'
  | 'delete_confirm'
  | 'rename'
  | 'lock'
  | 'unlock'
  | 'add_host'
  | 'remove_host'
  | 'claim'
  | 'templates'
  | 'open_panel'
