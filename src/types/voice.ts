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
  | 'hide'
  | 'show'
  | 'hosts'
  | 'claim'
  | 'open_panel'
  | 'options'       // open the ⚙️ Options sub-panel (lock/hide/hosts/claim/auto-name/delete)
  | 'auto_name'     // open the 🏷️ Auto Name sub-panel
  | 'auto_on'       // enable Smart auto-naming
  | 'auto_off'      // disable auto-naming (freeze the current name)
  | 'randomize'     // drop a random name and freeze it
  // Legacy actions — kept so older in-flight panels still decode cleanly.
  | 'templates'
  | 'template_apply'
