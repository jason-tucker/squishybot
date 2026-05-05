import { ActivityType, type GuildMember, type Activity } from 'discord.js'

export function findGameActivity(member: GuildMember, namePattern: RegExp): Activity | null {
  const activities = member.presence?.activities ?? []
  return activities.find(a => a.type === ActivityType.Playing && namePattern.test(a.name ?? '')) ?? null
}

export interface ModeInfo {
  display: string
  limit: number
}

export function inferOverwatchMode(activity: Activity): ModeInfo {
  const text = [activity.state, activity.details].filter(Boolean).join(' ').toLowerCase()

  if (/competitive|ranked/.test(text)) return { display: 'Competitive', limit: 5 }
  if (/quick\s*play|quickplay/.test(text)) return { display: 'Quickplay', limit: 5 }
  if (/6v6|classic|open queue 6/.test(text)) return { display: '6v6', limit: 6 }
  if (/custom/.test(text)) return { display: 'Custom Game', limit: 6 }
  if (/arcade/.test(text)) return { display: 'Arcade', limit: 5 }
  if (/practice/.test(text)) return { display: 'Practice', limit: 5 }
  if (/scrim|tournament/.test(text)) return { display: 'Scrim', limit: 6 }

  // Fallback: use whatever state/details has, default 5-stack
  const fallback = activity.state || activity.details || 'Match'
  return { display: fallback.slice(0, 40), limit: 5 }
}

/**
 * Returns a channel-name-friendly string for the activity, with mode detection
 * for Overwatch and Rocket League. Falls back to the raw game name.
 */
export function getSmartGameName(activity: Activity): string {
  const name = activity.name ?? ''
  if (/overwatch/i.test(name)) {
    return `Overwatch — ${inferOverwatchMode(activity).display}`
  }
  if (/rocket\s*league/i.test(name)) {
    return `Rocket League — ${inferRocketLeagueMode(activity).display}`
  }
  return name.slice(0, 100) || 'Match'
}

export function inferRocketLeagueMode(activity: Activity): ModeInfo {
  const text = [activity.state, activity.details].filter(Boolean).join(' ').toLowerCase()

  if (/1v1|duel|^1s\b/.test(text)) return { display: '1v1', limit: 2 }
  if (/2v2|doubles|^2s\b/.test(text)) return { display: 'Doubles', limit: 2 }
  if (/3v3|standard|^3s\b/.test(text)) return { display: 'Standard', limit: 3 }
  if (/hoops/.test(text)) return { display: 'Hoops', limit: 2 }
  if (/snow\s*day/.test(text)) return { display: 'Snow Day', limit: 3 }
  if (/rumble/.test(text)) return { display: 'Rumble', limit: 3 }
  if (/dropshot/.test(text)) return { display: 'Dropshot', limit: 3 }
  if (/ranked/.test(text)) return { display: 'Ranked', limit: 3 }
  if (/casual/.test(text)) return { display: 'Casual', limit: 3 }

  const fallback = activity.state || activity.details || 'Match'
  return { display: fallback.slice(0, 40), limit: 3 }
}
