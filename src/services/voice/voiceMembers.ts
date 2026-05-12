import { and, eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { autoChannelMembers } from '../../db/schema'
import { publish, voiceCh, type VoiceMemberJoinEvent, type VoiceMemberLeaveEvent } from '../eventBus'

export interface MemberJoin {
  userId: string
  joinedAt: Date
}

/** Record (or refresh, on rejoin) when a member entered the voice channel. */
export async function recordMemberJoin(voiceChannelId: string, userId: string, guildId?: string): Promise<void> {
  await db.insert(autoChannelMembers)
    .values({ voiceChannelId, userId, joinedAt: new Date() })
    .onConflictDoUpdate({
      target: [autoChannelMembers.voiceChannelId, autoChannelMembers.userId],
      set: { joinedAt: new Date() },
    })
    .catch(() => {})
  // Fan out to subscribers. guildId is optional because some callers (the
  // panel reconciler backfill) don't have it cheaply; in those cases we
  // skip the event rather than publish a half-filled payload.
  if (guildId) {
    void publish<VoiceMemberJoinEvent>(voiceCh('member_join'), {
      guildId, userId, channelId: voiceChannelId, ts: new Date().toISOString(),
    })
  }
}

/** Forget a member's join time (on leave or kick). */
export async function recordMemberLeave(voiceChannelId: string, userId: string, guildId?: string): Promise<void> {
  await db.delete(autoChannelMembers)
    .where(and(
      eq(autoChannelMembers.voiceChannelId, voiceChannelId),
      eq(autoChannelMembers.userId, userId),
    ))
    .catch(() => {})
  if (guildId) {
    void publish<VoiceMemberLeaveEvent>(voiceCh('member_leave'), {
      guildId, userId, channelId: voiceChannelId, ts: new Date().toISOString(),
    })
  }
}

/** Drop every row for a channel — call when the auto channel is deleted. */
export async function clearMembers(voiceChannelId: string): Promise<void> {
  await db.delete(autoChannelMembers)
    .where(eq(autoChannelMembers.voiceChannelId, voiceChannelId))
    .catch(() => {})
}

/** Fetch the current join-time map for a channel. */
export async function listMembers(voiceChannelId: string): Promise<MemberJoin[]> {
  const rows = await db.select()
    .from(autoChannelMembers)
    .where(eq(autoChannelMembers.voiceChannelId, voiceChannelId))
    .catch(() => [])
  return rows.map(r => ({ userId: r.userId, joinedAt: r.joinedAt }))
}

/**
 * Insert a join row only if there isn't one yet — used by the reconciler to
 * backfill members already in the channel at boot. We don't refresh the
 * timestamp because that would lie about how long they've been there.
 */
export async function backfillMember(voiceChannelId: string, userId: string): Promise<void> {
  await db.insert(autoChannelMembers)
    .values({ voiceChannelId, userId, joinedAt: new Date() })
    .onConflictDoNothing()
    .catch(() => {})
}

/**
 * Bulk variant of {@link backfillMember} — one INSERT for all userIds instead
 * of N parallel queries. The reconciler uses this on boot for each room's
 * members. No-op when the array is empty (drizzle errors on empty values).
 */
export async function backfillMembers(voiceChannelId: string, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return
  const now = new Date()
  await db.insert(autoChannelMembers)
    .values(userIds.map(userId => ({ voiceChannelId, userId, joinedAt: now })))
    .onConflictDoNothing()
    .catch(() => {})
}
