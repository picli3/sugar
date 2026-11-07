import type { EdgeRoute } from './edgeRouting'
import type { CategoryIconKey, CategoryIconMap } from './categoryIcons'
export type Role = 'view' | 'dev' | 'Admin'
export type User = { id: string; email: string; role: Role; language: 'es' | 'en'; theme: 'dark' | 'light'; display_name?: string | null; closed_at?: string | null; active?: boolean }
export type Port = { id: string; label: string; protocol: string; direction: 'in' | 'out' | 'bidirectional'; maxConnections?: number; color?: string }
export type Block = { name: string; function: string; model?: string; image?: string; design_block_kicad?: string; color?: string; category?: string; subcategory?: string; properties?: Record<string, unknown>; ports: Port[] }
export type DiagramNode = { id: string; position: { x: number; y: number }; block: Block; libraryId?: string; libraryVersion?: number }
export type DiagramEdge = { id: string; source: string; target: string; sourcePort: string; targetPort: string; route?: EdgeRoute }
export type Diagram = { name: string; nodes: DiagramNode[]; edges: DiagramEdge[] }
export type LibraryItem = { owner_id?: string | null; permissions?: { scope: 'catalog' | 'personal'; canEdit: boolean }; id: string; name: string; latest_version: number; yaml: string }
export type Category = { owner_id?: string | null; permissions?: { scope: 'catalog' | 'personal'; canEdit: boolean }; id: string; slug: string; name: string; parent_id: string | null; icon: CategoryIconKey | null; deleted_at: string | null }
export type ProjectItem = { permissions?: { role: 'owner' | 'editor' | 'reader'; canEdit: boolean; canManage: boolean }; category_icons?: CategoryIconMap; id: string; name: string; revision: number; yaml?: string; visibility: 'public' | 'private'; created_by: string | null; creator: string | null; created_at: string; sync_repository: string | null; sync_branch: string; settings_version: number }
export type Revision = { revision?: number; version?: number; summary: string; created_at: string; author: string | null }
