/**
 * One-shot: provision and link the 8 staff roles into `bot_settings`.
 *
 * Mirrors `/sudo → Settings → Staff Roles → Provision & link`, but runs from
 * the host without taking the bot's gateway connection. For each entry in
 * STAFF_ROLE_DEFS:
 *   1. If `bot_settings[def.key]` already points at an existing role — skip.
 *   2. Else if a guild role with `def.name` already exists — link it.
 *   3. Else create the role (hoisted, no color, no perms) and link it.
 *
 * Then bulk-reposition the 8 roles starting one above the highest game role,
 * preserving their order in STAFF_ROLE_DEFS (Leadership ends up on top).
 *
 * Run with:
 *   pnpm tsx src/scripts/provisionStaffRoles.ts
 *
 * After it completes, restart the bot so the in-memory settings cache reloads:
 *   squishybot restart
 */
import 'dotenv/config'
import { isNotNull, or } from 'drizzle-orm'
import { db } from '../db/client'
import { botSettings, games } from '../db/schema'
import { env } from '../config/env'
import { STAFF_ROLE_DEFS } from '../services/staffRoles'

interface DiscordRole {
  id: string
  name: string
  position: number
  managed: boolean
}

const API = 'https://discord.com/api/v10'
const TOKEN = env.DISCORD_BOT_TOKEN
const GUILD_ID = env.GUILD_ID

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
        'X-Audit-Log-Reason': 'staff role provisioning (one-shot via squishybot)',
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

async function upsertSetting(key: string, value: string): Promise<void> {
  await db.insert(botSettings)
    .values({ key, value, updatedByDiscordId: null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: botSettings.key,
      set: { value, updatedByDiscordId: null, updatedAt: new Date() },
    })
}

async function readLinkedSettings(): Promise<Record<string, string | null>> {
  const wanted = STAFF_ROLE_DEFS.map(d => d.key)
  const rows = await db.select().from(botSettings)
  const map: Record<string, string | null> = Object.fromEntries(wanted.map(k => [k, null]))
  for (const r of rows) {
    if (wanted.includes(r.key)) map[r.key] = r.value
  }
  return map
}

async function main(): Promise<void> {
  console.log(`▶ Provisioning ${STAFF_ROLE_DEFS.length} staff roles in guild ${GUILD_ID}...`)

  const [allRoles, gameRoleRows, linked] = await Promise.all([
    api<DiscordRole[]>('GET', `/guilds/${GUILD_ID}/roles`),
    db.select({ roleId: games.roleId, pingRoleId: games.pingRoleId })
      .from(games)
      .where(or(isNotNull(games.roleId), isNotNull(games.pingRoleId))),
    readLinkedSettings(),
  ])

  // Compute the highest game-role position so we know where to bump to.
  const gameRoleIds = new Set<string>()
  for (const r of gameRoleRows) {
    if (r.roleId) gameRoleIds.add(r.roleId)
    if (r.pingRoleId) gameRoleIds.add(r.pingRoleId)
  }
  let basePosition = 0
  for (const id of gameRoleIds) {
    const role = allRoles.find(r => r.id === id)
    if (role && role.position > basePosition) basePosition = role.position
  }
  console.log(`  base position (above highest game role): ${basePosition}`)

  const created: string[] = []
  const linkedNow: string[] = []
  const alreadyOk: string[] = []
  const errors: string[] = []
  const resolvedIds: Record<string, string> = {}

  for (const def of STAFF_ROLE_DEFS) {
    const linkedId = linked[def.key]
    if (linkedId && allRoles.some(r => r.id === linkedId)) {
      resolvedIds[def.key] = linkedId
      alreadyOk.push(def.label)
      console.log(`  ✓ ${def.label} — already linked (${linkedId})`)
      continue
    }
    const byName = allRoles.find(r => r.name === def.name && !r.managed)
    if (byName) {
      await upsertSetting(def.key, byName.id)
      resolvedIds[def.key] = byName.id
      linkedNow.push(def.label)
      console.log(`  → ${def.label} — linked existing role by name (${byName.id})`)
      continue
    }
    try {
      const newRole = await api<DiscordRole>('POST', `/guilds/${GUILD_ID}/roles`, {
        name: def.name,
        hoist: true,
        mentionable: false,
        permissions: '0',
      })
      await upsertSetting(def.key, newRole.id)
      resolvedIds[def.key] = newRole.id
      created.push(def.label)
      console.log(`  + ${def.label} — created and linked (${newRole.id})`)
    } catch (err) {
      const msg = (err as Error).message
      errors.push(`${def.label}: ${msg}`)
      console.error(`  ✗ ${def.label} — ${msg}`)
    }
    // Tiny spacing between role creations to be polite to the rate limiter.
    await sleep(150)
  }

  // Bulk reposition: each slot one above the previous, starting at base+1.
  const positions = STAFF_ROLE_DEFS
    .map((def, idx) => {
      const id = resolvedIds[def.key]
      return id ? { id, position: basePosition + 1 + idx } : null
    })
    .filter((p): p is { id: string; position: number } => p !== null)
  if (positions.length > 0) {
    try {
      await api('PATCH', `/guilds/${GUILD_ID}/roles`, positions)
      console.log(`  ⇡ repositioned ${positions.length} roles starting at ${basePosition + 1}`)
    } catch (err) {
      const msg = (err as Error).message
      errors.push(`reposition: ${msg}`)
      console.error(`  ✗ reposition — ${msg}`)
    }
  }

  console.log('\nSummary:')
  console.log(`  already linked: ${alreadyOk.length}${alreadyOk.length ? ' — ' + alreadyOk.join(', ') : ''}`)
  console.log(`  linked existing: ${linkedNow.length}${linkedNow.length ? ' — ' + linkedNow.join(', ') : ''}`)
  console.log(`  created: ${created.length}${created.length ? ' — ' + created.join(', ') : ''}`)
  if (errors.length) console.log(`  errors: ${errors.join(' | ')}`)
  console.log('\nDone. Restart the bot so its in-memory settings cache reloads:')
  console.log('  squishybot restart\n')
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err)
  process.exit(1)
})
