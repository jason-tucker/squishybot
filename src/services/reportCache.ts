import { randomBytes } from 'crypto'

export interface ReportSession {
  reporterId: string
  reporterTag: string
  title: string
  body: string
  labels: string[]
  createdAt: number
}

const sessions = new Map<string, ReportSession>()
const TTL_MS = 24 * 60 * 60 * 1000

function sweep(): void {
  const cutoff = Date.now() - TTL_MS
  for (const [k, v] of sessions) {
    if (v.createdAt < cutoff) sessions.delete(k)
  }
}

export function createReportSession(data: Omit<ReportSession, 'createdAt'>): string {
  sweep()
  const key = randomBytes(8).toString('hex')
  sessions.set(key, { ...data, createdAt: Date.now() })
  return key
}

export function getReportSession(key: string): ReportSession | undefined {
  return sessions.get(key)
}

export function deleteReportSession(key: string): void {
  sessions.delete(key)
}

/** Keys taken and not yet restored or released: a review is running on them. */
const inFlight = new Set<string>()
/** Keys whose review finished (filed or dropped), with the finish time. */
const handled = new Map<string, number>()

/**
 * Get and remove a session in one synchronous step and mark it in flight.
 * The first caller wins; a concurrent second click gets undefined and cannot
 * act on it again.
 */
export function takeReportSession(key: string): ReportSession | undefined {
  const session = sessions.get(key)
  if (session) {
    sessions.delete(key)
    inFlight.add(key)
  }
  return session
}

/** Put a taken session back (e.g. after a failed GitHub call) so it can be retried. */
export function restoreReportSession(key: string, session: ReportSession): void {
  inFlight.delete(key)
  sessions.set(key, session)
}

/** Mark a taken session as finished (filed or dropped). */
export function releaseReportSession(key: string): void {
  inFlight.delete(key)
  const cutoff = Date.now() - TTL_MS
  for (const [k, t] of handled) {
    if (t < cutoff) handled.delete(k)
  }
  handled.set(key, Date.now())
}

/**
 * Why a key has no takeable session: another click is still working on it,
 * it was already filed/dropped, or it is unknown (expired or lost on restart).
 */
export function reportSessionState(key: string): 'available' | 'in-flight' | 'handled' | 'unknown' {
  if (sessions.has(key)) return 'available'
  if (inFlight.has(key)) return 'in-flight'
  if (handled.has(key)) return 'handled'
  return 'unknown'
}
