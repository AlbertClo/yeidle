import type { AppContext } from '../context';

import { collapsedMap, UserDocument } from './userDocument';

/**
 * Collapsed blocks: the user document's `collapsed` map. Expanded is the
 * absence of an entry, so nested collapse choices stay independent.
 */
export class CollapsedBlocks {
    constructor(private ctx: AppContext) {}

    ids(): string[] {
        return collapsedMap(new UserDocument(this.ctx).read()).keys().sort();
    }

    collapse(blockIds: string[]): void {
        new UserDocument(this.ctx).edit((doc) => {
            const map = collapsedMap(doc);

            for (const id of blockIds) {
                if (map.get(id) !== true) {
                    map.set(id, true);
                }
            }
        }, 'Collapse');
    }

    expand(blockIds: string[]): void {
        new UserDocument(this.ctx).edit((doc) => {
            const map = collapsedMap(doc);

            for (const id of blockIds) {
                if (map.get(id) !== undefined) {
                    map.delete(id);
                }
            }
        }, 'Expand');
    }
}
