import type { VoiceAction } from '../types/voice'

const VC_PREFIX = 'vc'

export function encodeVcId(voiceChannelId: string, action: VoiceAction): string {
  return `${VC_PREFIX}:${voiceChannelId}:${action}`
}

export function decodeVcId(customId: string): { voiceChannelId: string; action: VoiceAction } | null {
  const parts = customId.split(':')
  if (parts.length !== 3 || parts[0] !== VC_PREFIX) return null
  return { voiceChannelId: parts[1], action: parts[2] as VoiceAction }
}

export function isVcCustomId(customId: string): boolean {
  return customId.startsWith(`${VC_PREFIX}:`)
}
