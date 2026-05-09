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
 *
 * Order in this list is the hierarchy order: first entry sits just above the
 * highest game role; last entry (Leadership) ends up on top.
 */
export interface StaffRoleDef {
  key: string
  slug: string
  label: string
  name: string
}

export const STAFF_ROLE_DEFS: StaffRoleDef[] = [
  { key: 'staff.role.tier_1',     slug: 'tier_1',     label: 'Tier 1',     name: 'Tier 1' },
  { key: 'staff.role.tier_2',     slug: 'tier_2',     label: 'Tier 2',     name: 'Tier 2' },
  { key: 'staff.role.tier_3',     slug: 'tier_3',     label: 'Tier 3',     name: 'Tier 3' },
  { key: 'staff.role.help_desk',  slug: 'help_desk',  label: 'Help Desk',  name: 'Help Desk' },
  { key: 'staff.role.onsites',    slug: 'onsites',    label: 'Onsites',    name: 'Onsites' },
  { key: 'staff.role.security',   slug: 'security',   label: 'Security',   name: 'Security' },
  { key: 'staff.role.sales',      slug: 'sales',      label: 'Sales',      name: 'Sales' },
  { key: 'staff.role.leadership', slug: 'leadership', label: 'Leadership', name: 'Leadership' },
]

export function findStaffRoleDefBySlug(slug: string): StaffRoleDef | undefined {
  return STAFF_ROLE_DEFS.find(d => d.slug === slug)
}

export function findStaffRoleDefByKey(key: string): StaffRoleDef | undefined {
  return STAFF_ROLE_DEFS.find(d => d.key === key)
}
