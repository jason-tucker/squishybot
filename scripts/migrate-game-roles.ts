/**
 * ONE-TIME migration: rename ping roles + migrate view roles to channel perms.
 *
 * Tracking: botpanel #211, sibling design issue #194.
 *
 * What this does
 * --------------
 * 1. For every `games` row with `ping_role_id`, fetch the role from Discord.
 *    If the role name ends in ` LFG` (case-insensitive, trimmed), rename it
 *    to the trimmed `games.name` (e.g. `Battlefield LFG` → `Battlefield`).
 *    Roles without the ` LFG` suffix are skipped with a notice.
 *
 * 2. For every `games` row with `role_id` (the "view role" concept we're
 *    abandoning):
 *      a. List all guild members holding that role.
 *      b. For each such member, add a per-channel `ViewChannel: Allow`
 *         permission overwrite on the linked `channel_id`.
 *      c. Delete the role from Discord.
 *      d. `UPDATE games SET role_id = NULL` for the row.
 *
 * Safety / posture
 * ----------------
 *  - **REST-only** — no gateway connection. The running bot keeps running.
 *  - **Dry-run by default.** Pass `--apply` to actually make changes.
 *  - Rate-limited at ~250 ms per Discord write to stay well under the
 *    50/10s global cap.
 *  - Idempotent: a re-run after success is a no-op (no LFG suffixes left,
 *    no role_id values left to migrate).
 *
 * Usage
 * -----
 *   pnpm tsx scripts/migrate-game-roles.ts            # dry-run
 *   pnpm tsx scripts/migrate-game-roles.ts --apply    # do it
 */
import { REST, Routes, PermissionFlagsBits, type RESTGetAPIGuildMembersResult, type RESTGetAPIGuildRolesResult } from 'discord.js'
import { db } from '../src/db/client'
import { games } from '../src/db/schema/games'
import { eq } from 'drizzle-orm'
import { env } from '../src/config/env'

const APPLY = process.argv.includes('--apply')
const RATE_DELAY_MS = 250

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}
function log(line: string): void {
  console.log(`[${ts()}] ${line}`)
}
async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

type GameRow = {
  id: string
  name: string
  channelId: string | null
  roleId: string | null
  pingRoleId: string | null
}

type DiscordRole = {
  id: string
  name: string
}

type DiscordMember = {
  user: { id: string; username: string } | null
  roles: string[]
}

async function listAllRoles(rest: REST, guildId: string): Promise<Map<string, DiscordRole>> {
  // `GET /guilds/{guild.id}/roles` returns the full role list in one shot.
  const data = (await rest.get(Routes.guildRoles(guildId))) as RESTGetAPIGuildRolesResult
  const map = new Map<string, DiscordRole>()
  for (const r of data) map.set(r.id, { id: r.id, name: r.name })
  return map
}

async function listAllMembers(rest: REST, guildId: string): Promise<DiscordMember[]> {
  // Page through `GET /guilds/{guild.id}/members?limit=1000&after=<lastId>`.
  // ITSRI is well under the 10k mark so this is at most a couple of pages.
  const all: DiscordMember[] = []
  let after: string | undefined
  for (;;) {
    const path = `${Routes.guildMembers(guildId)}?limit=1000${after ? `&after=${after}` : ''}`
    const page = (await rest.get(path as `/${string}`)) as RESTGetAPIGuildMembersResult
    if (page.length === 0) break
    for (const m of page) all.push(m as unknown as DiscordMember)
    if (page.length < 1000) break
    after = page[page.length - 1].user!.id
    await sleep(RATE_DELAY_MS)
  }
  return all
}

async function renamePingRoles(rest: REST, rows: GameRow[], roleMap: Map<string, DiscordRole>): Promise<{ renamed: number; skipped: number }> {
  let renamed = 0
  let skipped = 0
  for (const row of rows) {
    if (!row.pingRoleId) continue
    const role = roleMap.get(row.pingRoleId)
    if (!role) {
      log(`  SKIP  ping role ${row.pingRoleId} (game="${row.name}") not found in guild`)
      skipped++
      continue
    }
    const target = row.name.trim()
    const cur = role.name.trim()
    // Match any " LFG" suffix (case-insensitive). Also handle exact match
    // already to make this idempotent.
    if (cur === target) {
      log(`  ok    "${cur}" — already correct, no rename`)
      continue
    }
    if (!/\s+LFG\s*$/i.test(cur)) {
      log(`  SKIP  "${cur}" — doesn't end in " LFG", manual rename if needed`)
      skipped++
      continue
    }
    log(`  RENAME  "${cur}"  →  "${target}"`)
    if (APPLY) {
      await rest.patch(Routes.guildRole(env.GUILD_ID, role.id), {
        body: { name: target },
        reason: 'one-time: drop " LFG" suffix per #211',
      })
      await sleep(RATE_DELAY_MS)
    }
    renamed++
  }
  return { renamed, skipped }
}

async function migrateViewRoles(rest: REST, rows: GameRow[], roleMap: Map<string, DiscordRole>, members: DiscordMember[]): Promise<{ migrated: number; skipped: number }> {
  let migrated = 0
  let skipped = 0
  for (const row of rows) {
    if (!row.roleId) continue
    if (!row.channelId) {
      log(`  SKIP  view role for "${row.name}" — no channel_id, can't migrate to channel perm`)
      skipped++
      continue
    }
    const role = roleMap.get(row.roleId)
    if (!role) {
      log(`  WARN  view role ${row.roleId} (game="${row.name}") not in guild — just nulling DB row`)
      if (APPLY) {
        await db.update(games).set({ roleId: null }).where(eq(games.id, row.id))
      }
      skipped++
      continue
    }
    const holders = members.filter(m => m.roles.includes(role.id) && m.user)
    log(`  MIGRATE  view role "${role.name}" (game="${row.name}", channel=${row.channelId}, holders=${holders.length})`)
    if (APPLY) {
      for (const m of holders) {
        const userId = m.user!.id
        // PUT /channels/{channel.id}/permissions/{overwrite.id}
        // type=1 means member overwrite (vs role=0).
        await rest.put(Routes.channelPermission(row.channelId, userId), {
          body: {
            type: 1,
            allow: String(PermissionFlagsBits.ViewChannel),
            deny: '0',
          },
          reason: `one-time: migrate view-role "${role.name}" → per-user channel perm`,
        })
        log(`    +perm  user=${userId} (${m.user!.username})  on channel=${row.channelId}`)
        await sleep(RATE_DELAY_MS)
      }
      // Now delete the role.
      await rest.delete(Routes.guildRole(env.GUILD_ID, role.id), {
        reason: 'one-time: view-role concept removed per #194/#211',
      })
      log(`    DELETE role ${role.id} (${role.name})`)
      await sleep(RATE_DELAY_MS)
      // Null the DB column.
      await db.update(games).set({ roleId: null }).where(eq(games.id, row.id))
      log(`    UPDATE games SET role_id=NULL WHERE id=${row.id}`)
    }
    migrated++
  }
  return { migrated, skipped }
}

async function main(): Promise<void> {
  log(`migrate-game-roles starting — mode=${APPLY ? 'APPLY' : 'DRY-RUN'}  guild=${env.GUILD_ID}`)

  const rows: GameRow[] = await db
    .select({
      id: games.id,
      name: games.name,
      channelId: games.channelId,
      roleId: games.roleId,
      pingRoleId: games.pingRoleId,
    })
    .from(games)
  log(`loaded ${rows.length} games`)

  const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN)
  const roleMap = await listAllRoles(rest, env.GUILD_ID)
  log(`fetched ${roleMap.size} roles from Discord`)

  log('')
  log('=== STAGE 1: rename ping roles (drop " LFG" suffix) ===')
  const r1 = await renamePingRoles(rest, rows, roleMap)
  log(`  → renamed=${r1.renamed} skipped=${r1.skipped}`)

  // Only fetch the member list when we actually have view roles to migrate
  // (otherwise it's a wasted pagination loop).
  const viewRoleRows = rows.filter(r => r.roleId)
  let r2 = { migrated: 0, skipped: 0 }
  if (viewRoleRows.length > 0) {
    log('')
    log(`=== STAGE 2: migrate view roles to channel perms (${viewRoleRows.length} games) ===`)
    log('  fetching guild members …')
    const members = await listAllMembers(rest, env.GUILD_ID)
    log(`  fetched ${members.length} members`)
    r2 = await migrateViewRoles(rest, rows, roleMap, members)
    log(`  → migrated=${r2.migrated} skipped=${r2.skipped}`)
  } else {
    log('')
    log('=== STAGE 2: SKIPPED — no games have a view role (role_id) ===')
  }

  log('')
  log(`done. mode=${APPLY ? 'APPLY' : 'DRY-RUN'}  ping-renamed=${r1.renamed}  view-migrated=${r2.migrated}`)
  if (!APPLY) log('  (no changes made — re-run with --apply to commit)')
  // Drizzle's postgres-js client keeps the connection open; force-exit.
  process.exit(0)
}

main().catch((err: unknown) => {
  console.error('[migrate-game-roles] FAILED:', err)
  process.exit(1)
})
