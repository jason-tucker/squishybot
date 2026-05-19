/**
 * Helper: dump pairs of `games.name` vs the Discord ping role's CURRENT name,
 * filtered to rows where they don't match (after the LFG-suffix migration).
 * Read-only.
 */
import { REST, Routes, type RESTGetAPIGuildRolesResult } from 'discord.js'
import { db } from '../src/db/client'
import { games } from '../src/db/schema/games'
import { env } from '../src/config/env'

async function main(): Promise<void> {
  const rows = await db
    .select({ id: games.id, name: games.name, pingRoleId: games.pingRoleId })
    .from(games)
  const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN)
  const guildRoles = (await rest.get(Routes.guildRoles(env.GUILD_ID))) as RESTGetAPIGuildRolesResult
  const roleMap = new Map<string, string>()
  for (const r of guildRoles) roleMap.set(r.id, r.name)

  console.log('| games.name | Discord role name | match? |')
  console.log('|---|---|---|')
  const mismatches: { gameId: string; gameName: string; roleId: string; roleName: string }[] = []
  for (const row of rows) {
    if (!row.pingRoleId) continue
    const roleName = roleMap.get(row.pingRoleId) ?? '<not in guild>'
    const ok = row.name.trim() === roleName.trim()
    console.log(`| ${row.name} | ${roleName} | ${ok ? '✓' : '✗'} |`)
    if (!ok) {
      mismatches.push({
        gameId: row.id,
        gameName: row.name,
        roleId: row.pingRoleId,
        roleName,
      })
    }
  }
  console.log('')
  console.log(`Mismatches: ${mismatches.length}`)
  // Print a JSON-shaped block we can paste back as the input list.
  console.log(JSON.stringify(mismatches, null, 2))
  process.exit(0)
}
main().catch(err => {
  console.error(err)
  process.exit(1)
})
