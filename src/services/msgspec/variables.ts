/**
 * Variable + timestamp substitution for message specs.
 *
 * Token syntax (kept identical to the panel preview so WYSIWYG holds):
 *
 *   {{name}}          → ctx.values[name]
 *   {{name:mod}}      → for a "timestamp variable" (a unix-seconds entry in
 *                       ctx.timestamps), renders a Discord timestamp using the
 *                       style `mod` (t,T,d,D,f,F,R). Default style is `f`.
 *
 * Unknown names are left untouched (so a typo is visible rather than silently
 * blanked). Whitespace inside the braces is ignored.
 */

export type TimestampStyle = 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R'

export const TIMESTAMP_STYLES: TimestampStyle[] = ['t', 'T', 'd', 'D', 'f', 'F', 'R']

/** `<t:UNIX:style>` — the literal Discord renders client-side per viewer TZ. */
export function discordTimestamp(unixSeconds: number, style: TimestampStyle = 'f'): string {
  return `<t:${Math.floor(unixSeconds)}:${style}>`
}

export interface SubstitutionContext {
  /** Plain string variables: `{{game}}`, `{{host}}`, `{{list.in}}`, … */
  values: Record<string, string>
  /** Variables that render as Discord timestamps, keyed name → unix seconds. */
  timestamps?: Record<string, number>
}

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.]+)(?::([a-zA-Z]+))?\s*\}\}/g

function isTimestampStyle(s: string): s is TimestampStyle {
  return (TIMESTAMP_STYLES as string[]).includes(s)
}

export function substitute(text: string, ctx: SubstitutionContext): string {
  if (!text) return text
  const timestamps = ctx.timestamps ?? {}
  return text.replace(TOKEN_RE, (whole, name: string, mod: string | undefined) => {
    // Timestamp variables take precedence — they accept a style modifier.
    if (name in timestamps) {
      const style = mod && isTimestampStyle(mod) ? mod : 'f'
      return discordTimestamp(timestamps[name], style)
    }
    if (name in ctx.values) {
      return ctx.values[name]
    }
    // Unknown token — leave it as authored so the mistake is visible.
    return whole
  })
}
