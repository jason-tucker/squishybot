/**
 * Tiny dependency-free RSS 2.0 / Atom parser. Only extracts the fields the
 * social poller actually uses. Built for the third-party aggregators (rss.app,
 * fetchrss, etc.) that wrap Instagram / Twitter / YouTube / Mastodon profiles
 * — well-formed feeds with stable item shapes.
 *
 * Why hand-rolled instead of `rss-parser`: keeps the supply chain to
 * 5 packages, no install step on the VPS at deploy time, and the surface area
 * we need is small (item iteration + 6 fields).
 */

export interface RssItem {
  /** Stable identifier for dedup. Falls back to link, then to title. */
  guid: string
  title: string | null
  link: string | null
  description: string | null
  pubDate: Date | null
  imageUrl: string | null
}

/**
 * Hard cap on how many item/entry blocks we extract. Real feeds carry a few
 * dozen; this bounds total parsing work regardless of input.
 */
const MAX_ITEMS = 500

export function parseFeed(xml: string): RssItem[] {
  // Extract RSS <item>...</item> and Atom <entry>...</entry> blocks.
  //
  // SECURITY (H3): the previous matcher used a lazy regex
  // (`/<item\b[^>]*>([\s\S]*?)<\/item>/gi`) which backtracks *quadratically*
  // on input containing many unclosed `<item>` opens. A hostile/compromised
  // feed serving `"<item>".repeat(N)` within the 5 MB body cap could pin the
  // single-threaded event loop for minutes, freezing the whole bot. The
  // indexOf-based scan below is O(n) and the item cap bounds total work.
  const inners: string[] = []
  extractBlocks(xml, 'item', inners)
  extractBlocks(xml, 'entry', inners)
  return inners.map(parseBlock).filter((it): it is RssItem => it !== null)
}

/**
 * Append the inner text of up to MAX_ITEMS `<tag>…</tag>` blocks found in `xml`
 * to `out`, using a linear indexOf scan (no regex backtracking). Matches the
 * old regex's word-boundary behaviour: `<item>` and `<item attr="…">` match,
 * `<items>` does not.
 */
function extractBlocks(xml: string, tag: string, out: string[]): void {
  const open = `<${tag}`
  const close = `</${tag}>`
  let pos = 0
  while (out.length < MAX_ITEMS) {
    const start = xml.indexOf(open, pos)
    if (start === -1) break
    // Char right after the tag name must end the name (`>`, whitespace, or
    // self-close) — otherwise it's a different tag like `<items>`.
    const after = xml[start + open.length]
    if (after !== '>' && after !== ' ' && after !== '\t' && after !== '\n' && after !== '\r' && after !== '/') {
      pos = start + open.length
      continue
    }
    const openEnd = xml.indexOf('>', start + open.length)
    if (openEnd === -1) break
    const end = xml.indexOf(close, openEnd + 1)
    if (end === -1) break
    out.push(xml.slice(openEnd + 1, end))
    pos = end + close.length
  }
}

function parseBlock(inner: string): RssItem | null {
  const link = extractLink(inner)
  const title = decode(extractTag(inner, 'title'))
  const guidRaw = extractTag(inner, 'guid') ?? extractTag(inner, 'id')
  const guid = (guidRaw || link || title || '').trim()
  if (!guid) return null

  const description =
    decode(extractTag(inner, 'content:encoded'))
    ?? decode(extractTag(inner, 'description'))
    ?? decode(extractTag(inner, 'summary'))
    ?? decode(extractTag(inner, 'content'))

  const pubDateRaw = extractTag(inner, 'pubDate') ?? extractTag(inner, 'published') ?? extractTag(inner, 'updated')
  const pubDate = pubDateRaw ? new Date(pubDateRaw) : null

  return {
    guid,
    title,
    link,
    description,
    pubDate: pubDate && !isNaN(pubDate.getTime()) ? pubDate : null,
    imageUrl: extractImageUrl(inner, description),
  }
}

/** Strips CDATA wrappers and surrounding whitespace; returns null when empty. */
function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${escapeForRe(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeForRe(tag)}>`, 'i')
  const m = re.exec(xml)
  if (!m) return null
  let v = m[1].trim()
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v)
  if (cdata) v = cdata[1].trim()
  return v.length > 0 ? v : null
}

/** RSS uses <link>url</link>, Atom uses <link href="url"/>. Try both. */
function extractLink(xml: string): string | null {
  const text = extractTag(xml, 'link')
  if (text && /^https?:/i.test(text)) return text
  const atom = /<link\b[^>]*\bhref=["']([^"']+)["']/i.exec(xml)
  return atom ? atom[1] : null
}

function extractImageUrl(inner: string, description: string | null): string | null {
  // Common feed-image carriers: <media:content>, <media:thumbnail>, <enclosure>.
  const media = /<(?:media:content|media:thumbnail|enclosure)\b[^>]*\burl=["']([^"']+)["']/i.exec(inner)
  if (media) return media[1]

  // Last resort: first <img src> in the description HTML.
  if (description) {
    const img = /<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(description)
    if (img) return img[1]
  }
  return null
}

function escapeForRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&nbsp;': ' ',
}
function decode(v: string | null): string | null {
  if (v === null) return null
  return v.replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g, m => ENTITIES[m] ?? m)
}

/** Strip HTML tags, collapse whitespace. Used for description previews. */
export function stripHtml(s: string | null, max = 800): string {
  if (!s) return ''
  const stripped = decode(s.replace(/<[^>]+>/g, ' '))!.replace(/\s+/g, ' ').trim()
  return stripped.length > max ? stripped.slice(0, max - 1) + '…' : stripped
}
