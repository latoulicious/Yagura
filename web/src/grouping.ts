type GroupDef = { key: string; label: string; match: string }

const GROUPS: GroupDef[] = [
  { key: 'kanjo', label: 'Kanjo', match: 'kanjo' },
  { key: 'lazyscan', label: 'Lazyscan', match: 'lazyscan' },
  { key: 'raeon', label: 'Raeon', match: 'raeon' },
  { key: 'infra', label: 'Infra', match: 'shared' },
]
const OTHER: GroupDef = { key: 'other', label: 'Other', match: '' }

export function groupOf(name: string): GroupDef {
  return GROUPS.find((g) => name.startsWith(g.match)) ?? OTHER
}

/** Short label within a group: drop the project prefix + trailing `-N` replica. */
export function shortLabel(name: string): string {
  const g = groupOf(name)
  let s = name
  if (g.match && s.startsWith(g.match)) s = s.slice(g.match.length).replace(/^-/, '')
  s = s.replace(/-\d+$/, '')
  return s || name
}

export type Group<T> = { def: GroupDef; items: T[] }

/** Bucket items into the fixed group order, dropping empty groups. */
export function grouped<T extends { name: string }>(items: T[]): Group<T>[] {
  return [...GROUPS, OTHER]
    .map((def) => ({ def, items: items.filter((i) => groupOf(i.name).key === def.key) }))
    .filter((g) => g.items.length > 0)
}
