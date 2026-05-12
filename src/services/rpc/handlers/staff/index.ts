/**
 * Side-effect bundle of every staff-related RPC verb. Importing this
 * module from `ready.ts` (or any boot-path entry) registers all the
 * handlers below at once — mirrors the per-handler side-effect pattern
 * but lets the importing file keep a single line per handler family
 * instead of one line per verb.
 *
 * Add new staff verbs by creating a sibling file and importing it
 * here. Don't `export` from those modules — they self-register.
 */
import './grant'
import './revoke'
