/**
 * Staff role registry — the 7 staff roles a member can request via the
 * "Request Staff Role" flow and that `/sudo → Settings → Staff Roles`
 * provisions / links into `bot_settings`.
 *
 * `key`  — `bot_settings` key holding the linked Discord role ID.
 * `slug` — short token used inside customIds (must round-trip through Discord
 *          customId limits and match `[a-z0-9_]+`).
 * `label`— human-facing label (used in modals, approval cards, selects).
 * `name` — Discord role name (matched / created during provisioning).
 * `color`— canonical Discord role color (decimal). Applied at provision time
 *          to keep the 8 staff roles visually consistent across servers.
 *
 * Order in this list is the hierarchy order: first entry sits just above the
 * highest game role; last entry (Leadership) ends up on top.
 */
export interface StaffRoleDef {
  key: string
  slug: string
  label: string
  name: string
  color: number
}

export const STAFF_ROLE_DEFS: StaffRoleDef[] = [
  { key: 'staff.role.tier_1',     slug: 'tier_1',     label: 'Tier 1',     name: 'Tier 1',     color: 0x95a5a6 },
  { key: 'staff.role.tier_2',     slug: 'tier_2',     label: 'Tier 2',     name: 'Tier 2',     color: 0x3498db },
  { key: 'staff.role.tier_3',     slug: 'tier_3',     label: 'Tier 3',     name: 'Tier 3',     color: 0x1abc9c },
  { key: 'staff.role.help_desk',  slug: 'help_desk',  label: 'Help Desk',  name: 'Help Desk',  color: 0x2ecc71 },
  { key: 'staff.role.onsites',    slug: 'onsites',    label: 'Onsites',    name: 'Onsites',    color: 0xe67e22 },
  { key: 'staff.role.security',   slug: 'security',   label: 'Security',   name: 'Security',   color: 0xe74c3c },
  { key: 'staff.role.sales',      slug: 'sales',      label: 'Sales',      name: 'Sales',      color: 0xf1c40f },
  { key: 'staff.role.leadership', slug: 'leadership', label: 'Leadership', name: 'Leadership', color: 0x9b59b6 },
]

export function findStaffRoleDefBySlug(slug: string): StaffRoleDef | undefined {
  return STAFF_ROLE_DEFS.find(d => d.slug === slug)
}

export function findStaffRoleDefByKey(key: string): StaffRoleDef | undefined {
  return STAFF_ROLE_DEFS.find(d => d.key === key)
}
