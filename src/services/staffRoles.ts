/**
 * Staff role registry.
 *
 * 9 roles split across three categories:
 *   - `tier`       (3) — Tier 1 / Tier 2 / Tier 3 (seniority hierarchy).
 *   - `department` (5) — Help Desk / Onsites / Security / Sales / Leadership.
 *   - `base`       (1) — IT CRI Staff. Granted automatically on every
 *                        approval so anyone marked staff carries the umbrella
 *                        role too — useful for staff-only channel access.
 *
 * The "Request a Staff Role" flow on `/settings → Staff Role` (bot) and on
 * `/me/edit` (panel) lets a requester pick AT MOST one department and AT
 * MOST one tier per submission; both are optional individually but at
 * least one must be selected to make the request meaningful.
 *
 * On approval, the bot grants:
 *   - whichever department role was requested (if any),
 *   - whichever tier role was requested (if any),
 *   - the base role (always).
 *
 * Fields:
 *   `key`  — `bot_settings` key holding the linked Discord role ID.
 *   `slug` — short token used inside customIds (`[a-z0-9_]+`).
 *   `label`— human-facing label (modals, approval cards, selects).
 *   `name` — Discord role name (matched / created during provisioning).
 *   `color`— canonical Discord role color, applied at provision time.
 *   `category` — 'tier' | 'department' | 'base'.
 */
export type StaffRoleCategory = 'tier' | 'department' | 'base'

export interface StaffRoleDef {
  key: string
  slug: string
  label: string
  name: string
  color: number
  category: StaffRoleCategory
}

export const STAFF_ROLE_DEFS: StaffRoleDef[] = [
  // Tiers (lowest → highest)
  { key: 'staff.role.tier_1',       slug: 'tier_1',       label: 'Tier 1',       name: 'Tier 1',       color: 0x95a5a6, category: 'tier' },
  { key: 'staff.role.tier_2',       slug: 'tier_2',       label: 'Tier 2',       name: 'Tier 2',       color: 0x3498db, category: 'tier' },
  { key: 'staff.role.tier_3',       slug: 'tier_3',       label: 'Tier 3',       name: 'Tier 3',       color: 0x1abc9c, category: 'tier' },
  // Departments
  { key: 'staff.role.help_desk',    slug: 'help_desk',    label: 'Help Desk',    name: 'Help Desk',    color: 0x2ecc71, category: 'department' },
  { key: 'staff.role.onsites',      slug: 'onsites',      label: 'Onsites',      name: 'Onsites',      color: 0xe67e22, category: 'department' },
  { key: 'staff.role.security',     slug: 'security',     label: 'Security',     name: 'Security',     color: 0xe74c3c, category: 'department' },
  { key: 'staff.role.sales',        slug: 'sales',        label: 'Sales',        name: 'Sales',        color: 0xf1c40f, category: 'department' },
  { key: 'staff.role.leadership',   slug: 'leadership',   label: 'Leadership',   name: 'Leadership',   color: 0x9b59b6, category: 'department' },
  // Base — auto-granted on every approval.
  { key: 'staff.role.it_cri_staff', slug: 'it_cri_staff', label: 'IT CRI Staff', name: 'IT CRI Staff', color: 0x3b88c3, category: 'base' },
]

export const DEPARTMENT_DEFS: StaffRoleDef[] = STAFF_ROLE_DEFS.filter((d) => d.category === 'department')
export const TIER_DEFS: StaffRoleDef[] = STAFF_ROLE_DEFS.filter((d) => d.category === 'tier')
export const BASE_DEFS: StaffRoleDef[] = STAFF_ROLE_DEFS.filter((d) => d.category === 'base')

export function findStaffRoleDefBySlug(slug: string): StaffRoleDef | undefined {
  return STAFF_ROLE_DEFS.find((d) => d.slug === slug)
}

export function findStaffRoleDefByKey(key: string): StaffRoleDef | undefined {
  return STAFF_ROLE_DEFS.find((d) => d.key === key)
}

export function findDepartmentBySlug(slug: string): StaffRoleDef | undefined {
  return DEPARTMENT_DEFS.find((d) => d.slug === slug)
}

export function findTierBySlug(slug: string): StaffRoleDef | undefined {
  return TIER_DEFS.find((d) => d.slug === slug)
}
