import { mergeAttributes, Node } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';

export const FileNode = Node.create({
    name: 'fileNode',
    group: 'block',
    atom: true,

    addAttributes() {
        return {
            mediaId: { default: null },
            src: { default: null },
            originalName: { default: null },
            mimeType: { default: null },
            size: { default: null },
        };
    },

    parseHTML() {
        return [{ tag: 'div[data-file-node]' }];
    },

    renderHTML({ node, HTMLAttributes }) {
        const { mediaId, src, originalName, mimeType, size } = node.attrs;
        const isImage = mimeType?.startsWith('image/');
        const isVideo = mimeType?.startsWith('video/');

        if (isImage) {
            return [
                'div',
                mergeAttributes(HTMLAttributes, {
                    'data-file-node': '',
                    'data-media-id': mediaId,
                    class: 'file-node file-node-image',
                }),
                ['img', { src, alt: originalName, loading: 'lazy' }],
            ];
        }

        if (isVideo) {
            return [
                'div',
                mergeAttributes(HTMLAttributes, {
                    'data-file-node': '',
                    'data-media-id': mediaId,
                    class: 'file-node file-node-video',
                }),
                ['video', { src, controls: 'true', preload: 'metadata' }],
            ];
        }

        const sizeStr = size ? formatSize(size) : '';
        return [
            'div',
            mergeAttributes(HTMLAttributes, {
                'data-file-node': '',
                'data-media-id': mediaId,
                class: 'file-node file-node-file',
            }),
            ['span', { class: 'file-node-icon' }, '📎'],
            ['span', { class: 'file-node-name' }, originalName || 'File'],
            ['span', { class: 'file-node-size' }, sizeStr],
        ];
    },

    renderText({ node }) {
        return `[${node.attrs.originalName || 'File'}]`;
    },

    addProseMirrorPlugins() {
        return [
            new Plugin({
                props: {
                    handleDrop: (view, event) => {
                        const files = event.dataTransfer?.files;
                        if (!files || files.length === 0) return false;

                        event.preventDefault();
                        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });

                        Array.from(files).forEach((file) => {
                            uploadFile(file).then((media) => {
                                if (media && pos) {
                                    const node = view.state.schema.nodes.fileNode.create({
                                        mediaId: media.id,
                                        src: `/api/media/${media.id}`,
                                        originalName: media.original_name,
                                        mimeType: media.mime_type,
                                        size: media.size,
                                    });
                                    const tr = view.state.tr.insert(pos.pos, node);
                                    view.dispatch(tr);
                                }
                            });
                        });

                        return true;
                    },
                    handlePaste: (view, event) => {
                        const items = event.clipboardData?.items;
                        if (!items) return false;

                        for (const item of items) {
                            if (item.kind === 'file') {
                                const file = item.getAsFile();
                                if (!file) continue;

                                event.preventDefault();

                                uploadFile(file).then((media) => {
                                    if (media) {
                                        const node = view.state.schema.nodes.fileNode.create({
                                            mediaId: media.id,
                                            src: `/api/media/${media.id}`,
                                            originalName: media.original_name,
                                            mimeType: media.mime_type,
                                            size: media.size,
                                        });
                                        const tr = view.state.tr.replaceSelectionWith(node);
                                        view.dispatch(tr);
                                    }
                                });

                                return true;
                            }
                        }

                        return false;
                    },
                },
            }),
        ];
    },
});

async function uploadFile(file: File): Promise<{
    id: string;
    original_name: string;
    mime_type: string;
    size: number;
} | null> {
    const formData = new FormData();
    formData.append('file', file);

    try {
        const res = await fetch('/api/media', {
            method: 'POST',
            headers: { Accept: 'application/json' },
            body: formData,
        });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
