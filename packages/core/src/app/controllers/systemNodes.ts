import { placeholders } from '../../db/database';
import { abort, HttpError, json } from '../../http/http';
import type { Router } from '../../http/router';
import { isUuid } from '../../support/ids';
import type { AppContext } from '../context';
import { findNode, serializeNode } from '../nodes';
import type { NodeRow } from '../nodes';
import { CollapsedNodes } from '../services/collapsedNodes';
import { DailyNoteService, isDailyNoteDate } from '../services/dailyNotes';
import { PinNodes } from '../services/pins';
import {
    FONT_FAMILIES,
    MAX_FONT_SIZE,
    MIN_FONT_SIZE,
    PreferenceNodes,
    THEMES,
    WORKSPACE_STORAGE_OPTIONS,
} from '../services/preferences';

/** Pins, collapsed nodes, preferences and daily notes. */
export function registerSystemNodeRoutes(
    router: Router,
    ctx: AppContext,
): void {
    const pins = () => new PinNodes(ctx);
    const collapsed = () => new CollapsedNodes(ctx);
    const preferences = () => new PreferenceNodes(ctx);

    // Route model binding: missing and soft-deleted nodes are 404s
    const boundNode = (id: string): NodeRow =>
        findNode(ctx.db(), id) ?? abort(404);

    router.post('/api/daily-notes', ({ input }) => {
        const v = new Validator(input.all());
        const date = input.raw('date');

        if (v.required('date') && !isDailyNoteDate(date)) {
            v.fail(
                'date',
                `The ${label('date')} field must match the format Y-m-d.`,
            );
        }

        v.throwIfFailed();

        const page = new DailyNoteService(ctx).open(
            ctx.workspace().id,
            date as string,
        );

        return json({ id: page.id, date: page.daily_note_date });
    });

    router.get('/api/pins', () => {
        const listing = pins().listing();

        return json({
            root_id: listing.root_id,
            items: listing.items.map(serializeNode),
        });
    });

    router.put('/api/pins/order', ({ input }) => {
        const v = new Validator(input.all());
        const nodeIds = input.raw('node_ids');

        if (!('node_ids' in input.all())) {
            v.fail(
                'node_ids',
                `The ${label('node_ids')} field must be present.`,
            );
        } else if (!Array.isArray(nodeIds)) {
            v.fail(
                'node_ids',
                `The ${label('node_ids')} field must be an array.`,
            );
        } else {
            if (nodeIds.length > 1000) {
                v.fail(
                    'node_ids',
                    `The ${label('node_ids')} field must not have more than 1000 items.`,
                );
            }

            v.uuidItems('node_ids', nodeIds);
        }

        v.throwIfFailed();

        if (!pins().reorder(nodeIds as string[])) {
            throw new HttpError(
                422,
                'The pinned list changed. Reload it and try again.',
                {
                    node_ids: [
                        'The pinned list changed. Reload it and try again.',
                    ],
                },
            );
        }

        return json({ reordered: true });
    });

    router.put('/api/nodes/{node}/pin', ({ params }) => {
        const node = boundNode(params.node);
        pins().add(node);

        return json({ pinned: true, item: serializeNode(node) });
    });

    router.delete('/api/nodes/{node}/pin', ({ params }) => {
        const node = boundNode(params.node);
        pins().remove(node.id);

        return json({ pinned: false });
    });

    router.get('/api/collapsed-nodes', () => json(collapsed().listing()));

    router.put('/api/collapsed-nodes', ({ input }) => {
        const v = new Validator(input.all());
        const nodeIds = input.raw('node_ids');

        if (v.required('node_ids')) {
            if (!Array.isArray(nodeIds)) {
                v.fail(
                    'node_ids',
                    `The ${label('node_ids')} field must be an array.`,
                );
            } else {
                if (nodeIds.length > 25000) {
                    v.fail(
                        'node_ids',
                        `The ${label('node_ids')} field must not have more than 25000 items.`,
                    );
                }

                v.uuidItems('node_ids', nodeIds);
            }
        }

        if (
            v.required('collapsed') &&
            ![true, false, 0, 1, '0', '1'].includes(
                input.raw('collapsed') as never,
            )
        ) {
            v.fail(
                'collapsed',
                `The ${label('collapsed')} field must be true or false.`,
            );
        }

        v.throwIfFailed();

        const ids = nodeIds as string[];
        const nodes: NodeRow[] = [];

        for (let i = 0; i < ids.length; i += 500) {
            const chunk = ids.slice(i, i + 500);
            nodes.push(
                ...ctx
                    .db()
                    .all<NodeRow>(
                        `SELECT * FROM nodes WHERE id IN (${placeholders(chunk.length)}) AND deleted_at IS NULL`,
                        chunk,
                    ),
            );
        }

        if (nodes.length !== ids.length) {
            abort(404);
        }

        const value = input.raw('collapsed');

        if (value === true || value === 1 || value === '1') {
            collapsed().collapse(nodes);
        } else {
            collapsed().expand(nodes);
        }

        return json(collapsed().listing());
    });

    router.get('/api/preferences', () => json(preferences().listing()));

    router.put('/api/preferences/theme', ({ input }) => {
        const v = new Validator(input.all());
        v.inList('theme', THEMES);
        v.throwIfFailed();

        const service = preferences();
        service.setTheme(input.raw('theme') as string);

        return json(service.listing());
    });

    router.put('/api/preferences/typography', ({ input }) => {
        const v = new Validator(input.all());
        v.inList('font_family', FONT_FAMILIES);

        let fontSize: number | null = null;

        if (v.required('font_size')) {
            fontSize = laravelInteger(input.raw('font_size'));

            if (fontSize === null) {
                v.fail(
                    'font_size',
                    `The ${label('font_size')} field must be an integer.`,
                );
            } else if (fontSize < MIN_FONT_SIZE || fontSize > MAX_FONT_SIZE) {
                v.fail(
                    'font_size',
                    `The ${label('font_size')} field must be between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE}.`,
                );
            }
        }

        v.throwIfFailed();

        const service = preferences();
        service.setTypography(input.raw('font_family') as string, fontSize!);

        return json(service.listing());
    });

    router.put('/api/preferences/workspace-storage', ({ input }) => {
        const v = new Validator(input.all());
        v.inList('workspace_storage', WORKSPACE_STORAGE_OPTIONS);
        v.throwIfFailed();

        const service = preferences();
        service.setWorkspaceStorage(input.raw('workspace_storage') as string);

        return json(service.listing());
    });
}

/** Laravel's displayable attribute name (`node_ids.0` → `node ids.0`). */
function label(attribute: string): string {
    return attribute.replace(/_/g, ' ');
}

/** PHP's FILTER_VALIDATE_INT as Laravel's `integer` rule applies it. */
function laravelInteger(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isInteger(value) ? value : null;
    }

    if (typeof value === 'string' && /^\s*[+-]?(0|[1-9]\d*)\s*$/.test(value)) {
        return Number(value.trim());
    }

    return null;
}

/** Collects errors per field, failing like Laravel's validator (422, all fields at once). */
class Validator {
    private errors: Record<string, string[]> = {};

    constructor(private data: Record<string, unknown>) {}

    fail(field: string, message: string): void {
        this.errors[field] ??= [];
        this.errors[field].push(message);
    }

    /** Laravel's `required`: present and not null, '' or []. Returns whether it passed. */
    required(field: string): boolean {
        const value = this.data[field];

        if (
            value === undefined ||
            value === null ||
            (typeof value === 'string' && value.trim() === '') ||
            (Array.isArray(value) && value.length === 0)
        ) {
            this.fail(field, `The ${label(field)} field is required.`);

            return false;
        }

        return true;
    }

    /** `required|string|in:...` */
    inList(field: string, values: readonly string[]): void {
        if (!this.required(field)) {
            return;
        }

        const value = this.data[field];

        if (typeof value !== 'string') {
            this.fail(field, `The ${label(field)} field must be a string.`);
        } else if (!values.includes(value)) {
            this.fail(field, `The selected ${label(field)} is invalid.`);
        }
    }

    /** `field.* => required|string|uuid|distinct` */
    uuidItems(field: string, items: unknown[]): void {
        const counts = new Map<unknown, number>();

        for (const item of items) {
            counts.set(item, (counts.get(item) ?? 0) + 1);
        }

        items.forEach((item, i) => {
            const key = `${field}.${i}`;

            if (item === null || item === undefined || item === '') {
                this.fail(key, `The ${label(key)} field is required.`);

                return;
            }

            if (typeof item !== 'string') {
                this.fail(key, `The ${label(key)} field must be a string.`);
            }

            if (!isUuid(item)) {
                this.fail(key, `The ${label(key)} field must be a valid UUID.`);
            }

            if ((counts.get(item) ?? 0) > 1) {
                this.fail(
                    key,
                    `The ${label(key)} field has a duplicate value.`,
                );
            }
        });
    }

    throwIfFailed(): void {
        const messages = Object.values(this.errors).flat();

        if (messages.length === 0) {
            return;
        }

        const more = messages.length - 1;
        const message =
            more > 0
                ? `${messages[0]} (and ${more} more error${more === 1 ? '' : 's'})`
                : messages[0];

        throw new HttpError(422, message, this.errors);
    }
}
