import { env } from '../config/env'

export function startHealthPush(intervalMs = 60_000) {
  const url = env.UPTIME_KUMA_PUSH_URL
  if (!url) return

  setInterval(async () => {
    try {
      await fetch(url)
    } catch {
      // silently swallow — Kuma will alert if pushes stop arriving
    }
  }, intervalMs)
}
