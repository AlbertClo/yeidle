import type { AppContext } from '../context';
import { pagesInOrder } from '../pages';
import type { Page } from '../pages';

import { pinsList, UserDocument } from './userDocument';

/** Pinned pages: the user document's `pins` list of page ids. */
export class Pins {
    constructor(private ctx: AppContext) {}

    /** Pinned pages that exist, in order. */
    listing(): Page[] {
        return pagesInOrder(this.ctx.db(), this.ids());
    }

    isPinned(pageId: string): boolean {
        return this.ids().includes(pageId);
    }

    add(pageId: string): void {
        new UserDocument(this.ctx).edit((doc) => {
            const list = pinsList(doc);

            if (!(list.toArray() as string[]).includes(pageId)) {
                list.push(pageId);
            }
        }, 'Pin page');
    }

    remove(pageId: string): void {
        new UserDocument(this.ctx).edit((doc) => {
            const list = pinsList(doc);

            // Two devices may have pinned the same page
            for (let i = list.length - 1; i >= 0; i--) {
                if (list.get(i) === pageId) {
                    list.delete(i, 1);
                }
            }
        }, 'Unpin page');
    }

    /**
     * Puts the pins in the given order. Returns false when `pageIds` isn't
     * exactly the pinned pages (the list changed meanwhile).
     */
    reorder(pageIds: string[]): boolean {
        const current = this.listing().map((page) => page.id);

        if (
            pageIds.length !== current.length ||
            pageIds.some((id) => !current.includes(id))
        ) {
            return false;
        }

        new UserDocument(this.ctx).edit((doc) => {
            const list = pinsList(doc);

            pageIds.forEach((pageId, target) => {
                const from = (list.toArray() as string[]).indexOf(pageId);

                if (from !== target) {
                    list.move(from, target);
                }
            });
        }, 'Reorder pins');

        return true;
    }

    /** Unique pinned ids in order (pages that were deleted included). */
    private ids(): string[] {
        return [
            ...new Set(
                pinsList(
                    new UserDocument(this.ctx).read(),
                ).toArray() as string[],
            ),
        ];
    }
}
