import { ActivityType, type GuildMember } from 'discord.js'
import { randomTechName } from './randomName'

export function generateChannelName(member: GuildMember, existingNames: string[]): string {
  const base = sanitizeChannelName(buildBaseName(member))
  if (!existingNames.includes(base)) return base
  for (let i = 2; i <= 99; i++) {
    const candidate = `${base} ${i}`
    if (!existingNames.includes(candidate)) return candidate
  }
  return `${base} ${Date.now()}`
}

function buildBaseName(member: GuildMember): string {
  const activities = member.presence?.activities ?? []
  const game = activities.find(a => a.type === ActivityType.Playing)
  if (game) return game.name.slice(0, 100)
  return randomTechName()
}

export function sanitizeChannelName(name: string): string {
  return name
    .replace(/[^\w\s'()/.-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'Voice Channel'
}
