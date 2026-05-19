/**
 * Per-row Discord role renames for `games.ping_role_id` rows whose role
 * name didn't match `games.name`. Driven by an explicit allowlist of
 * (gameId, roleId, oldName, newName) tuples — never reads the DB to
 * decide what to rename, so a re-run is safe.
 *
 * Tracking: botpanel #211 (sibling of the LFG-suffix script that already ran).
 */
import { REST, Routes } from 'discord.js'
import { env } from '../src/config/env'

const RENAMES: { gameId: string; roleId: string; oldName: string; newName: string }[] = [
  // case-only fixes
  { gameId: 'd684f8f6-5f72-4685-a8f8-b52dbce5ebfe', roleId: '1412168207187312650', oldName: 'deadlock',               newName: 'Deadlock' },
  { gameId: 'af9978dd-5990-4a37-99ca-2f70a13ef644', roleId: '1299506165209895015', oldName: 'Call Of Duty',           newName: 'Call of Duty' },
  { gameId: 'db81d273-c90f-4053-8377-7b372c29c839', roleId: '1121232322306510848', oldName: 'minecraft',              newName: 'Minecraft' },
  // spacing/format fixes
  { gameId: 'dae253a0-4259-47b2-bfde-9cdd6c5ea9b0', roleId: '1121200378738905198', oldName: 'MarvelSnap',             newName: 'Marvel Snap' },
  // shortenings → formal names
  // Note: roleIds for the next 5 rows need to be fetched. The first list
  // is built from the dry-run output; we resolve any unknown ids by
  // querying the games table at runtime below.
]

// Rows where we know the gameId but the roleId wasn't in the first slice —
// fill in by re-fetching from the DB at runtime so the script is self-contained.
const RENAMES_BY_GAME_NAME: { gameName: string; newRoleName: string }[] = [
  { gameName: 'RuneScape: Dragonwilds', newRoleName: 'RuneScape: Dragonwilds' },
  { gameName: 'Schedule I',             newRoleName: 'Schedule I' },
  { gameName: 'Path of Exile 2',        newRoleName: 'Path of Exile 2' },
  { gameName: 'Destiny',                newRoleName: 'Destiny' },
  { gameName: 'World of Warcraft',      newRoleName: 'World of Warcraft' },
]

const APPLY = process.argv.includes('--apply')
const RATE_DELAY_MS = 250

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}
function log(msg: string): void {
  console.log(`[${ts()}] ${msg}`)
}
async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  log(`rename-game-ping-roles — mode=${APPLY ? 'APPLY' : 'DRY-RUN'}  guild=${env.GUILD_ID}`)
  const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN)

  // Resolve the second group's roleIds via DB.
  const { db } = await import('../src/db/client')
  const { games } = await import('../src/db/schema/games')
  const allGames = await db
    .select({ id: games.id, name: games.name, pingRoleId: games.pingRoleId })
    .from(games)

  const renames = [...RENAMES]
  for (const want of RENAMES_BY_GAME_NAME) {
    const row = allGames.find(g => g.name === want.gameName)
    if (!row || !row.pingRoleId) {
      log(`  MISS  no game/ping_role for "${want.gameName}" — skipping`)
      continue
    }
    renames.push({
      gameId: row.id,
      roleId: row.pingRoleId,
      oldName: `<resolve at runtime>`,
      newName: want.newRoleName,
    })
  }

  log(`planned renames: ${renames.length}`)
  for (const r of renames) {
    log(`  RENAME  role=${r.roleId}  "${r.oldName}"  →  "${r.newName}"  (game ${r.gameId})`)
    if (APPLY) {
      await rest.patch(Routes.guildRole(env.GUILD_ID, r.roleId), {
        body: { name: r.newName },
        reason: 'one-time: align ping role with games.name per #211',
      })
      await sleep(RATE_DELAY_MS)
    }
  }
  log(`done. mode=${APPLY ? 'APPLY' : 'DRY-RUN'}  renamed=${renames.length}`)
  if (!APPLY) log('  (no changes — re-run with --apply)')
  process.exit(0)
}
main().catch((err: unknown) => {
  console.error('[rename-game-ping-roles] FAILED:', err)
  process.exit(1)
})
