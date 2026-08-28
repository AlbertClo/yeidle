import { mergeAttributes, Node } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';

import { requestCloudExchange } from '../sync/cloud';
import type { UploadedMedia } from './mediaInsertion';

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
                    'data-src': src,
                    'data-original-name': originalName,
                    class: 'file-node file-node-image',
                }),
                ['img', { src, alt: originalName, loading: 'lazy' }],
                ['button', { class: 'file-node-menu-btn', contenteditable: 'false', 'data-media-menu': mediaId }, '⋮'],
            ];
        }

        if (isVideo) {
            return [
                'div',
                mergeAttributes(HTMLAttributes, {
                    'data-file-node': '',
                    'data-media-id': mediaId,
                    'data-src': src,
                    'data-original-name': originalName,
                    class: 'file-node file-node-video',
                }),
                ['video', { src, controls: 'true', preload: 'metadata' }],
                ['button', { class: 'file-node-menu-btn', contenteditable: 'false', 'data-media-menu': mediaId }, '⋮'],
            ];
        }

        const sizeStr = size ? formatSize(size) : '';
        return [
            'div',
            mergeAttributes(HTMLAttributes, {
                'data-file-node': '',
                'data-media-id': mediaId,
                'data-original-name': originalName,
                class: 'file-node file-node-file',
            }),
            ['span', { class: 'file-node-icon' }, '📎'],
            ['span', { class: 'file-node-name' }, originalName || 'File'],
            ['span', { class: 'file-node-size' }, sizeStr],
            ['button', { class: 'file-node-menu-btn', contenteditable: 'false', 'data-media-menu': mediaId }, '⋮'],
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

const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB chunks

export async function uploadFile(file: File): Promise<UploadedMedia | null> {
    try {
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

        // 1. Init upload
        const initRes = await fetch('/api/media/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                filename: file.name,
                size: file.size,
                mime_type: file.type || 'application/octet-stream',
                total_chunks: totalChunks,
            }),
        });
        if (!initRes.ok) return null;
        const { upload_id } = await initRes.json();

        // 2. Send chunks
        for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const chunk = file.slice(start, start + CHUNK_SIZE);
            const formData = new FormData();
            formData.append('upload_id', upload_id);
            formData.append('chunk_index', String(i));
            formData.append('chunk', chunk, `chunk_${i}`);

            const chunkRes = await fetch('/api/media/chunk', {
                method: 'POST',
                headers: { Accept: 'application/json' },
                body: formData,
            });
            if (!chunkRes.ok) return null;
        }

        // 3. Complete
        const completeRes = await fetch('/api/media/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ upload_id }),
        });
        if (!completeRes.ok) return null;
        const media = await completeRes.json();

        // media.create is minted inside the local PHP endpoint rather than
        // through pushOps(), so explicitly wake durable blob/op delivery.
        void requestCloudExchange();

        return media;
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
