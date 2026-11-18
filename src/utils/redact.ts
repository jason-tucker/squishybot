/**
 * Pure helpers for keeping credentials out of logs.
 * No env / db / logger imports so they are safe to use anywhere (and in tests).
 */
const INVALID_URL = '<invalid redis url>'

/**
 * Returns `scheme://host[:port][/db]` with any username, password, query and
 * fragment removed. If the input cannot be parsed, or looks like it carries
 * credentials that did not parse as userinfo, returns a fixed placeholder and
 * never the raw input.
 */
export function redactUrl(url: string | undefined | null, placeholder: string = INVALID_URL): string {
  if (typeof url !== 'string') return placeholder
  try {
    const u = new URL(url)
    if (!u.host) return placeholder
    // '@' present but no userinfo parsed (e.g. "redis://u:1234/ab@h:6379"):
    // the secret ended up in the path/host, so do not echo anything.
    if (url.includes('@') && !u.username && !u.password) return placeholder
    const path = /^\/\d+$/.test(u.pathname) ? u.pathname : ''
    return `${u.protocol}//${u.host}${path}`
  } catch {
    return placeholder
  }
}

export interface SecretPattern {
  value: string | undefined
  label: string
}

/** Replace every known secret substring in `s` with its label. */
export function redactSecrets(s: string, patterns: SecretPattern[]): string {
  let out = s
  for (const { value, label } of patterns) {
    if (value && value.length > 6 && out.includes(value)) {
      out = out.split(value).join(label)
    }
  }
  return out
}

/**
 * Patterns that scrub a connection URL and its password (raw and decoded) from
 * text, labelled `[REDACTED:<name>_URL]` / `[REDACTED:<name>_PASSWORD]`.
 */
export function urlSecretPatterns(url: string | undefined, name: string): SecretPattern[] {
  if (!url) return []
  const patterns: SecretPattern[] = [{ value: url, label: `[REDACTED:${name}_URL]` }]
  try {
    const u = new URL(url)
    if (u.password) {
      patterns.push({ value: u.password, label: `[REDACTED:${name}_PASSWORD]` })
      try {
        patterns.push({ value: decodeURIComponent(u.password), label: `[REDACTED:${name}_PASSWORD]` })
      } catch { /* malformed escape: raw form already added */ }
    }
  } catch { /* unparseable: whole-URL pattern still applies */ }
  return patterns
}

/** Patterns that scrub a Redis URL and its password (raw and decoded) from text. */
export function redisSecretPatterns(url: string | undefined): SecretPattern[] {
  return urlSecretPatterns(url, 'REDIS')
}

/**
 * Build a client with `make`, converting any thrown error (which for a bad URL
 * carries the raw input) into a fixed, credential-free Error.
 */
export function constructWithoutLeak<T>(make: () => T, what: string, url: string | undefined, kind: string = 'redis'): T {
  try {
    return make()
  } catch {
    const target = url === undefined ? `<redacted ${kind} url>` : redactUrl(url, `<invalid ${kind} url>`)
    throw new Error(`${what}: could not create ${kind} client for ${target}`)
  }
}

// Any `://userinfo@` left in text after the known-value patterns ran (greedy
// to the last '@' before whitespace, so an unencoded '@' in a password is covered).
const URL_USERINFO = /:\/\/\S*@/g
const MAX_FIELD_LEN = 1000
// Bound the regex work on huge inputs; anything past this is dropped anyway.
const MAX_SCAN_LEN = 8 * MAX_FIELD_LEN
const MAX_CAUSE_DEPTH = 3
// Postgres (postgres.js PostgresError) fields worth printing, with their labels.
const PG_FIELDS: Array<[string, string]> = [
  ['detail', 'detail'],
  ['hint', 'hint'],
  ['position', 'position'],
  ['where', 'where'],
  ['schema_name', 'schema'],
  ['table_name', 'table'],
  ['column_name', 'column'],
  ['constraint_name', 'constraint'],
]

/** Scrub known secrets and any URL userinfo from `s`, then cap its length. */
export function scrubText(s: string, patterns: SecretPattern[]): string {
  const out = redactSecrets(s.slice(0, MAX_SCAN_LEN), patterns).replace(URL_USERINFO, '://[REDACTED]@')
  return out.length > MAX_FIELD_LEN ? `${out.slice(0, MAX_FIELD_LEN)}… [truncated]` : out
}

/**
 * Credential-free, multi-line summary of an error and its `.cause` chain (the
 * error plus up to 3 causes): name, code, message and, for Postgres errors,
 * detail/hint/position/where/schema/table/column/constraint. Only these
 * whitelisted string fields are read; every one goes through `scrubText`. Other
 * properties (e.g. `input`, `query`, `params`) are never printed.
 */
export function summarizeError(err: unknown, patterns: SecretPattern[]): string {
  const lines: string[] = []
  const seen = new Set<unknown>()
  let cur: unknown = err
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    if (cur === null || (typeof cur !== 'object' && typeof cur !== 'function')) {
      if (depth === 0) return `unknown error (${cur === null ? 'null' : typeof cur})`
      break
    }
    if (seen.has(cur)) break
    seen.add(cur)
    const e = cur as Record<string, unknown>
    const str = (k: string): string | undefined => {
      let v: unknown
      try { v = e[k] } catch { return undefined } // throwing getter
      return typeof v === 'string' && v.length > 0 ? scrubText(v, patterns) : undefined
    }
    const name = str('name') ?? 'Error'
    const code = str('code')
    const message = str('message') ?? '(no message)'
    const indent = depth === 0 ? '' : '  '.repeat(depth)
    lines.push(`${indent}${depth === 0 ? '' : 'caused by: '}${name}${code ? ` [${code}]` : ''}: ${message}`)
    for (const [key, label] of PG_FIELDS) {
      const v = str(key)
      if (v !== undefined) lines.push(`${indent}  ${label}: ${v}`)
    }
    cur = e.cause
  }
  return lines.join('\n')
}
