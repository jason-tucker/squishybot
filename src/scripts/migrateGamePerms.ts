/**
 * One-shot migration: lock down each game channel so /games "View" actually
 * gates access, and preserve every existing role-holder's view by writing
 * member-level overwrites + DB rows.
 *
 * For each game with a resolvable channel:
 *   1. Resolve the ping role: explicit `pingRoleId`, else case-insensitive
 *      name/alias match against guild roles. Persist the resolution to
 *      `games.ping_role_id` so we don't rely on name fallback at runtime.
 *   2. Permission overwrites on the channel:
 *      - @everyone DENY ViewChannel
 *      - Bot (this client user) ALLOW ViewChannel + SendMessages + ManageMessages + ReadMessageHistory
 *      - Each SUDO_ROLE_IDS role ALLOW ViewChannel + SendMessages + ReadMessageHistory
 *   3. For every member currently holding the resolved ping role:
 *      - ALLOW ViewChannel + ReadMessageHistory on the channel (preserves
 *        their existing access; the @everyone deny would otherwise revoke it)
 *      - INSERT/UPDATE user_game_prefs to mark wantsView=true, wantsPing=true
 *
 * Run with:
 *   docker compose run --rm --entrypoint "" squishybot node dist/scripts/migrateGamePerms.js
 */
import 'dotenv/config'
import { eq, and } from 'drizzle-orm'
import { db } from '../db/client'
import { games, userGamePrefs } from '../db/schema'
import { env } from '../config/env'

interface DiscordRole {
  id: string
  name: string
  position: number
}
interface DiscordChannel {
  id: string
  name: string
  type: number
  permission_overwrites?: { id: string; type: 0 | 1; allow: string; deny: string }[]
}
interface DiscordMember {
  user: { id: string; username: string; bot?: boolean }
  roles: string[]
}

const API = 'https://discord.com/api/v10'
const TOKEN = env.DISCORD_BOT_TOKEN
const GUILD_ID = env.GUILD_ID
const BOT_ID = env.DISCORD_CLIENT_ID

const ALLOW_BOT = (
  (1n << 10n) |  // VIEW_CHANNEL
  (1n << 11n) |  // SEND_MESSAGES
  (1n << 13n) |  // MANAGE_MESSAGES
  (1n << 16n)    // READ_MESSAGE_HISTORY
).toString()

const ALLOW_SUDO = (
  (1n << 10n) |  // VIEW_CHANNEL
  (1n << 11n) |  // SEND_MESSAGES
  (1n << 16n)    // READ_MESSAGE_HISTORY
).toString()

const ALLOW_MEMBER_VIEW = (
  (1n << 10n) |  // VIEW_CHANNEL
  (1n << 16n)    // READ_MESSAGE_HISTORY
).toString()

const DENY_VIEW = (1n << 10n).toString()  // VIEW_CHANNEL

async function sleep(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms))
}

async function api<T>(method: string, path: string, body?: unknown, retries = 5): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        'Content-Type': 'application/json',
        'X-Audit-Log-Reason': 'Migrating game channel perms (one-shot via squishybot)',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (res.status === 429) {
      const data = await res.json().catch(() => ({} as any)) as { retry_after?: number }
      const wait = Math.ceil((data.retry_after ?? 1) * 1000) + 250
      console.log(`  ⏳ rate-limited on ${method} ${path} — waiting ${wait}ms`)
      await sleep(wait)
      continue
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`${method} ${path} ${res.status}: ${text}`)
    }
    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
  }
  throw new Error(`${method} ${path}: gave up after ${retries} retries`)
}

async function fetchAllMembers(): Promise<DiscordMember[]> {
  // Paginate just in case the guild grows; default limit 1000 is plenty here.
  const out: DiscordMember[] = []
  let after = '0'
  for (;;) {
    const page = await api<DiscordMember[]>('GET', `/guilds/${GUILD_ID}/members?limit=1000&after=${after}`)
    if (page.length === 0) break
    out.push(...page)
    if (page.length < 1000) break
    after = page[page.length - 1].user.id
  }
  return out
}

async function setOverwrite(channelId: string, id: string, type: 0 | 1, allow: string, deny: string): Promise<void> {
  await api('PUT', `/channels/${channelId}/permissions/${id}`, { type, allow, deny })
  // Tiny delay to spread the per-channel overwrite bucket; cheap insurance
  // against the 5-per-5s shared bucket eating the migration on a slower run.
  await sleep(150)
}

function findPingRoleId(roles: DiscordRole[], game: { name: string; aliases: string[]; pingRoleId: string | null }): string | null {
  if (game.pingRoleId) {
    const r = roles.find(r => r.id === game.pingRoleId)
    if (r) return r.id
  }
  const candidates = [game.name, ...game.aliases].map(s => s.trim().toLowerCase()).filter(Boolean)
  for (const r of roles) {
    if (candidates.includes(r.name.trim().toLowerCase())) return r.id
  }
  return null
}

async function main(): Promise<void> {
  console.log('▶ Loading guild state...')
  const [allRoles, allMembers, allGames] = await Promise.all([
    api<DiscordRole[]>('GET', `/guilds/${GUILD_ID}/roles`),
    fetchAllMembers(),
    db.select().from(games),
  ])
  console.log(`  ${allRoles.length} roles · ${allMembers.length} members · ${allGames.length} games`)

  const sudoRoleIds = env.SUDO_ROLE_IDS

  let touchedChannels = 0
  let memberOverwrites = 0
  let prefsUpserted = 0
  let skippedNoChannel = 0
  let skippedNoRole = 0

  for (const g of allGames) {
    if (!g.channelId) {
      console.log(`⚪ ${g.name}: no channel linked — skipping`)
      skippedNoChannel++
      continue
    }

    const channel = await api<DiscordChannel>('GET', `/channels/${g.channelId}`).catch(() => null)
    if (!channel) {
      console.log(`⚠️  ${g.name}: channel ${g.channelId} not found — skipping`)
      skippedNoChannel++
      continue
    }
    if (channel.type !== 0 && channel.type !== 5 && channel.type !== 15) {
      console.log(`⚠️  ${g.name}: channel ${channel.name} type=${channel.type} not text-like — skipping`)
      skippedNoChannel++
      continue
    }

    const pingRoleId = findPingRoleId(allRoles, g)

    // 1. Persist resolved ping role to the catalog row so it's stable.
    if (pingRoleId && pingRoleId !== g.pingRoleId) {
      await db.update(games).set({ pingRoleId }).where(eq(games.id, g.id))
      console.log(`  ↻ ${g.name}: linked ping role ${pingRoleId}`)
    }

    // 2. Lock the channel: @everyone deny view; bot + sudo roles allow.
    await setOverwrite(channel.id, GUILD_ID, 0, '0', DENY_VIEW)  // @everyone role id == guild id
    await setOverwrite(channel.id, BOT_ID, 1, ALLOW_BOT, '0')
    for (const sudoRoleId of sudoRoleIds) {
      await setOverwrite(channel.id, sudoRoleId, 0, ALLOW_SUDO, '0')
    }
    touchedChannels++

    // 3. For each member with the ping role, allow them on this channel and
    //    record the prefs. Skip bots and the bot itself.
    if (!pingRoleId) {
      console.log(`✓  ${g.name} (#${channel.name}): locked (no role members to preserve — no role linked yet)`)
      skippedNoRole++
      continue
    }
    const holders = allMembers.filter(m => m.roles.includes(pingRoleId) && !m.user.bot)
    for (const m of holders) {
      await setOverwrite(channel.id, m.user.id, 1, ALLOW_MEMBER_VIEW, '0')
      memberOverwrites++

      await db.insert(userGamePrefs).values({
        guildId: GUILD_ID,
        userId: m.user.id,
        gameId: g.id,
        wantsView: true,
        wantsPing: true,
      }).onConflictDoUpdate({
        target: [userGamePrefs.guildId, userGamePrefs.userId, userGamePrefs.gameId],
        set: { wantsView: true, wantsPing: true },
      })
      prefsUpserted++
    }
    console.log(`✓  ${g.name} (#${channel.name}): locked, preserved view for ${holders.length} role-holder(s)`)
  }

  console.log('')
  console.log('══════════════════ Summary ══════════════════')
  console.log(`Channels gated:        ${touchedChannels}`)
  console.log(`Member overwrites set: ${memberOverwrites}`)
  console.log(`Pref rows upserted:    ${prefsUpserted}`)
  console.log(`Skipped (no channel):  ${skippedNoChannel}`)
  console.log(`Skipped (no role):     ${skippedNoRole}`)
  process.exit(0)
}

main().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})
