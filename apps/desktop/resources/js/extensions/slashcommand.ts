import { Extension } from '@tiptap/core';
import { type SuggestionOptions } from '@tiptap/suggestion';
import Suggestion from '@tiptap/suggestion';
import { VueRenderer } from '@tiptap/vue-3';
import tippy, { type Instance } from 'tippy.js';
import { Upload } from 'lucide-vue-next';
import SlashCommandSuggestion from '@/components/SlashCommandSuggestion.vue';
import type { SlashCommandItem } from '@/components/SlashCommandSuggestion.vue';
import { uploadFile } from '@/extensions/filenode';
import {
    insertMediaAsSiblingNodes,
    selectedListItemId,
} from '@/extensions/mediaInsertion';
import type { UploadedMedia } from '@/extensions/mediaInsertion';

const COMMANDS: SlashCommandItem[] = [
    { id: 'upload', label: 'Upload file', icon: Upload, action: 'upload' },
];

export const SlashCommand = Extension.create({
    name: 'slashCommand',

    addOptions() {
        return {
            suggestion: {
                char: '/',
                startOfLine: false,
                items: ({ query }: { query: string }) => {
                    return COMMANDS.filter((item) =>
                        item.label.toLowerCase().includes(query.toLowerCase()),
                    );
                },
                render: () => {
                    let component: VueRenderer;
                    let popup: Instance[];

                    return {
                        onStart: (props: any) => {
                            component = new VueRenderer(
                                SlashCommandSuggestion,
                                {
                                    props,
                                    editor: props.editor,
                                },
                            );

                            if (!props.clientRect) return;

                            popup = tippy('body', {
                                getReferenceClientRect:
                                    props.clientRect as () => DOMRect,
                                appendTo: () => document.body,
                                content: component.element as HTMLElement,
                                showOnCreate: true,
                                interactive: true,
                                trigger: 'manual',
                                placement: 'bottom-start',
                            });
                        },
                        onUpdate: (props: any) => {
                            component.updateProps(props);
                            if (props.clientRect) {
                                popup[0].setProps({
                                    getReferenceClientRect:
                                        props.clientRect as () => DOMRect,
                                });
                            }
                        },
                        onKeyDown: (props: any) => {
                            if (props.event.key === 'Escape') {
                                popup[0].hide();
                                return true;
                            }
                            return (
                                component.ref?.onKeyDown(props.event) ?? false
                            );
                        },
                        onExit: () => {
                            popup[0].destroy();
                            component.destroy();
                        },
                    };
                },
                command: ({ editor, range, props: item }: any) => {
                    // Delete the /command text
                    editor.chain().focus().deleteRange(range).run();

                    if (item.action === 'upload') {
                        const anchorBlockId = selectedListItemId(editor);
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.multiple = true;
                        input.onchange = async () => {
                            const files = Array.from(input.files ?? []);

                            if (!anchorBlockId || files.length === 0) {
                                return;
                            }

                            const uploads = await Promise.all(
                                files.map((file) => uploadFile(file)),
                            );
                            const mediaItems = uploads.filter(
                                (media): media is UploadedMedia =>
                                    media !== null,
                            );

                            insertMediaAsSiblingNodes(
                                editor,
                                anchorBlockId,
                                mediaItems,
                            );
                        };
                        input.click();
                    }
                },
            } satisfies Omit<SuggestionOptions<SlashCommandItem>, 'editor'>,
        };
    },

    addProseMirrorPlugins() {
        return [
            Suggestion({
                editor: this.editor,
                ...this.options.suggestion,
            }),
        ];
    },
});
