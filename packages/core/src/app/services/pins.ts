import { placeholders } from '../../db/database';
import type { NodeChange } from '../../loro/nodeOps';
import { abort } from '../../http/http';
import type { AppContext } from '../context';
import {
    childrenOf,
    findNode,
    isPage,
    isReachable,
    isSystemNode,
    SystemNodes,
} from '../nodes';
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
 * Pins live in the normal synced node graph: hidden workspace root ->
 * hidden account root -> pin entries whose content is the pinned page's id.
 */
export class PinNodes {
    static readonly ROOT_ID = SystemNodes.PINS_ROOT_ID;

    constructor(private ctx: AppContext) {}

    listing(): { root_id: string; items: NodeRow[] } {
        const db = this.ctx.db();
        const rootId = this.activeRootId();
        const entries = this.entries(rootId);
        const ids = [
            ...new Set(
                entries.map((entry) => entry.content).filter((id) => id !== ''),
            ),
        ];
        const itemsById = new Map<string, NodeRow>();

        if (ids.length > 0) {
            for (const row of db.all<NodeRow>(
                `SELECT * FROM nodes WHERE id IN (${placeholders(ids.length)}) AND deleted_at IS NULL`,
                ids,
            )) {
                itemsById.set(row.id, row);
            }
        }

        return {
            root_id: rootId,
            items: entries
                .map((entry) => itemsById.get(entry.content))
                .filter(
                    (item): item is NodeRow =>
                        item !== undefined &&
                        isPage(item) &&
                        isReachable(db, item) &&
                        !isSystemNode(db, item),
                ),
        };
    }

    isPinned(nodeId: string): boolean {
        return (
            findNode(this.ctx.db(), entryId(this.activeRootId(), nodeId)) !==
            null
        );
    }

    add(node: NodeRow): void {
        const db = this.ctx.db();

        if (!(
            isPage(node) &&
            isReachable(db, node) &&
            !isSystemNode(db, node)
        )) {
            abort(404);
        }

        db.transaction(() => {
            const rootId = this.activeRootId();
            const id = entryId(rootId, node.id);

            if (findNode(db, id) !== null) {
                return;
            }

            const entries = this.entries(rootId);
            const changes: NodeChange[] = [
                ...containerChanges(PinNodes.ROOT_ID, rootId),
                ...entries.map((entry, index) =>
                    setChange(entry.id, rootId, {
                        position: positionAt(index),
                    }),
                ),
                setChange(
                    id,
                    rootId,
                    entryFields(rootId, positionAt(entries.length), node.id),
                ),
            ];

            this.ctx.documents().applyChanges(changes, 'Pin page');
        });
    }

    remove(nodeId: string): void {
        const db = this.ctx.db();

        db.transaction(() => {
            const rootId = this.activeRootId();
            const entry = findNode(db, entryId(rootId, nodeId));

            if (entry === null) {
                return;
            }

            this.ctx
                .documents()
                .applyChanges([deleteChange(entry.id, rootId)], 'Unpin page');
        });
    }

    reorder(nodeIds: string[]): boolean {
        return this.ctx.db().transaction(() => {
            const rootId = this.activeRootId();
            const entriesByNode = new Map(
                this.entries(rootId).map((entry) => [entry.content, entry]),
            );

            if (
                nodeIds.length !== entriesByNode.size ||
                nodeIds.some((nodeId) => !entriesByNode.has(nodeId))
            ) {
                return false;
            }

            this.ctx.documents().applyChanges(
                nodeIds.map((nodeId, index) =>
                    setChange(entriesByNode.get(nodeId)!.id, rootId, {
                        position: positionAt(index),
                    }),
                ),
                'Reorder pins',
            );

            return true;
        });
    }

    activeRootId(): string {
        return activeAccountRoot(
            this.ctx.db(),
            PinNodes.ROOT_ID,
            (localRootId, cloudRootId) =>
                this.adoptAccountRoot(localRootId, cloudRootId),
        );
    }

    private adoptAccountRoot(localRootId: string, cloudRootId: string): void {
        if (findNode(this.ctx.db(), localRootId) === null) {
            return;
        }

        const cloudEntries = new Set(
            this.entries(cloudRootId).map((entry) => entry.content),
        );
        const changes = containerChanges(PinNodes.ROOT_ID, cloudRootId);

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

        changes.push(deleteChange(localRootId, PinNodes.ROOT_ID));
        this.ctx.documents().applyChanges(changes, 'Adopt pins');
    }

    private entries(rootId: string): NodeRow[] {
        return childrenOf(this.ctx.db(), rootId);
    }
}
