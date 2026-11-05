// Vue Flow reports keyboard selection (Tab + Enter/Space) only as `select` changes, not as
// clicks; the inspector follows the newly selected element either way (#28).
export type SelectionChange = { type: string; id?: string; selected?: boolean }
export function selectedId(changes: SelectionChange[]): string | null {
  return changes.find(change => change.type === 'select' && change.selected === true && typeof change.id === 'string' && change.id !== '')?.id ?? null
}
