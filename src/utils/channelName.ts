import type { GuildMember } from 'discord.js'

export function generateChannelName(member: GuildMember, existingNames: string[]): string {
  const raw = `${member.displayName}'s Channel`
  const base = sanitizeChannelName(raw)
  if (!existingNames.includes(base)) return base
  for (let i = 2; i <= 99; i++) {
    const candidate = `${base} ${i}`
    if (!existingNames.includes(candidate)) return candidate
  }
  return `${base} ${Date.now()}`
}

export function sanitizeChannelName(name: string): string {
  return name
    .replace(/[^\w\s'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'Voice Channel'
}
