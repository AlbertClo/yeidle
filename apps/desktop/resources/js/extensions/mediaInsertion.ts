import type { Editor } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import type { Node as PmNode } from '@tiptap/pm/model';
import { uuidv7 } from 'uuidv7';

export type UploadedMedia = {
    id: string;
    original_name: string;
    mime_type: string;
    size: number;
};

export function selectedListItemId(editor: Editor): string | null {
    const { $from } = editor.state.selection;

    for (let depth = $from.depth; depth > 0; depth--) {
        const node = $from.node(depth);

        if (node.type.name === 'listItem') {
            return (node.attrs.blockId as string | null) ?? null;
        }
    }

    return null;
}

function findListItem(
    editor: Editor,
    blockId: string,
): { pos: number; node: PmNode } | null {
    let found: { pos: number; node: PmNode } | null = null;

    editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'listItem' && node.attrs.blockId === blockId) {
            found = { pos, node };

            return false;
        }
    });

    return found;
}

export function insertMediaAsSiblingNodes(
    editor: Editor,
    anchorBlockId: string,
    mediaItems: UploadedMedia[],
): boolean {
    const anchor = findListItem(editor, anchorBlockId);

    if (!anchor || mediaItems.length === 0) {
        return false;
    }

    const fileNodeType = editor.state.schema.nodes.fileNode;
    const listItemType = editor.state.schema.nodes.listItem;

    if (!fileNodeType || !listItemType) {
        return false;
    }

    const createFileNode = (media: UploadedMedia) =>
        fileNodeType.create({
            mediaId: media.id,
            src: `/api/media/${media.id}`,
            originalName: media.original_name,
            mimeType: media.mime_type,
            size: media.size,
        });

    const contentBlocks: PmNode[] = [];
    let contentSize = 0;
    anchor.node.forEach((child) => {
        if (child.type.name !== 'bulletList') {
            contentBlocks.push(child);
            contentSize += child.nodeSize;
        }
    });

    const currentNodeIsEmpty =
        contentBlocks.length === 1 &&
        contentBlocks[0].type.name === 'paragraph' &&
        contentBlocks[0].content.size === 0;
    const transaction = editor.state.tr;
    let firstSiblingIndex = 0;

    if (currentNodeIsEmpty) {
        transaction.replaceWith(
            anchor.pos + 1,
            anchor.pos + 1 + contentSize,
            createFileNode(mediaItems[0]),
        );
        firstSiblingIndex = 1;
    }

    const siblings = mediaItems
        .slice(firstSiblingIndex)
        .map((media) =>
            listItemType.create(
                { blockId: uuidv7(), checked: null },
                createFileNode(media),
            ),
        );

    if (siblings.length > 0) {
        const insertPosition = transaction.mapping.map(
            anchor.pos + anchor.node.nodeSize,
            1,
        );
        transaction.insert(insertPosition, Fragment.fromArray(siblings));
    }

    editor.view.dispatch(transaction.scrollIntoView());
    editor.commands.focus();

    return true;
}
