import type { NodeChange } from '../../loro/nodeOps';
import { abort } from '../../http/http';
import type { AppContext } from '../context';
import { findNode, isPage, SystemNodes } from '../nodes';
import type { NodeRow } from '../nodes';

import {
    activeAccountRoot,
    containerChanges,
    deleteChange,
    entryFields,
    entryId,
    setChange,
} from './accountRoots';
import { positionAt } from './positions';

/**
 * Personal collapse state stored in the normal synced node graph: hidden
 * workspace root -> hidden account root -> collapsed node ids. Expansion is
 * the absence of an entry, so nested collapse choices stay independent.
 */
export class CollapsedNodes {
    static readonly ROOT_ID = SystemNodes.COLLAPSED_NODES_ROOT_ID;

    constructor(private ctx: AppContext) {}

    listing(): { root_id: string; node_ids: string[] } {
        const rootId = this.activeRootId();

        return {
            root_id: rootId,
            node_ids: this.entries(rootId)
                .map((entry) => entry.content)
                .filter((id) => typeof id === 'string' && id !== ''),
        };
    }

    collapse(nodes: NodeRow[]): void {
        const valid = nodes.filter((node) => isCollapsible(node));

        if (valid.length === 0 || valid.length !== nodes.length) {
            abort(404);
        }

        this.ctx.db().transaction(() => {
            const rootId = this.activeRootId();
            const existing = new Set(
                this.entriesForNodeIds(rootId, valid.map((node) => node.id)).map((entry) => entry.content),
            );
            const changes: NodeChange[] = containerChanges(CollapsedNodes.ROOT_ID, rootId);

            for (const node of valid) {
                if (existing.has(node.id)) {
                    continue;
                }

                changes.push(
                    setChange(entryId(rootId, node.id), rootId, entryFields(rootId, positionAt(0), node.id)),
                );
            }

            this.ctx.documents().applyChanges(changes, 'Collapse');
        });
    }

    expand(nodes: NodeRow[]): void {
        this.ctx.db().transaction(() => {
            const rootId = this.activeRootId();
            const nodeIds = nodes.filter((node) => isCollapsible(node)).map((node) => node.id);

            if (nodeIds.length === 0) {
                return;
            }

            const entries = this.entriesForNodeIds(rootId, nodeIds);

            if (entries.length === 0) {
                return;
            }

            this.ctx.documents().applyChanges(
                entries.map((entry) => deleteChange(entry.id, rootId)),
                'Expand',
            );
        });
    }

    activeRootId(): string {
        return activeAccountRoot(this.ctx.db(), CollapsedNodes.ROOT_ID, (localRootId, cloudRootId) =>
            this.adoptAccountRoot(localRootId, cloudRootId),
        );
    }

    private adoptAccountRoot(localRootId: string, cloudRootId: string): void {
        if (findNode(this.ctx.db(), localRootId) === null) {
            return;
        }

        const cloudEntries = new Set(this.entries(cloudRootId).map((entry) => entry.content));
        const changes = containerChanges(CollapsedNodes.ROOT_ID, cloudRootId);

        for (const entry of this.entries(localRootId)) {
            if (!cloudEntries.has(entry.content)) {
                changes.push(
                    setChange(
                        entryId(cloudRootId, entry.content),
                        cloudRootId,
                        entryFields(cloudRootId, entry.position, entry.content),
                    ),
                );
            }

            changes.push(deleteChange(entry.id, localRootId));
        }

        changes.push(deleteChange(localRootId, CollapsedNodes.ROOT_ID));
        this.ctx.documents().applyChanges(changes, 'Adopt collapsed nodes');
    }

    private entries(rootId: string): NodeRow[] {
        return this.ctx
            .db()
            .all<NodeRow>('SELECT * FROM nodes WHERE parent_id = ? AND deleted_at IS NULL ORDER BY id', [
                rootId,
            ]);
    }

    private entriesForNodeIds(rootId: string, nodeIds: string[]): NodeRow[] {
        if (nodeIds.length === 0) {
            return [];
        }

        const wanted = new Set(nodeIds);

        return this.entries(rootId).filter((entry) => wanted.has(entry.content));
    }
}

function isCollapsible(node: NodeRow): boolean {
    return !isPage(node) && !SystemNodes.isRoot(node.id);
}
