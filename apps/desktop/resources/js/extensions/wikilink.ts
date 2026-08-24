import { type SuggestionOptions } from '@tiptap/suggestion';
import { VueRenderer } from '@tiptap/vue-3';
import tippy, { type Instance } from 'tippy.js';
import WikiLinkSuggestion from '@/components/WikiLinkSuggestion.vue';
import type { SuggestionItem } from '@/components/WikiLinkSuggestion.vue';

export function wikiLinkSuggestion(): Omit<
    SuggestionOptions<SuggestionItem>,
    'editor'
> {
    return {
        char: '[[',
        items: async ({ query }) => {
            const items: SuggestionItem[] = [];

            if (query.length > 0) {
                const res = await fetch(
                    `/api/search?q=${encodeURIComponent(query)}`,
                    {
                        headers: { Accept: 'application/json' },
                    },
                );
                const data = await res.json();

                const pages = data.filter(
                    (n: { parent_id: string | null }) => !n.parent_id,
                );
                for (const page of pages.slice(0, 10)) {
                    items.push({
                        id: page.id,
                        content: page.content || '[untitled]',
                    });
                }

                const exactMatch = items.some(
                    (i) => i.content.toLowerCase() === query.toLowerCase(),
                );
                if (!exactMatch) {
                    items.unshift({
                        id: `create:${query}`,
                        content: query,
                        isCreate: true,
                    });
                }
            } else {
                const res = await fetch('/api/pages', {
                    headers: { Accept: 'application/json' },
                });
                const data = await res.json();
                for (const page of data.slice(0, 10)) {
                    items.push({
                        id: page.id,
                        content: page.content || '[untitled]',
                    });
                }
            }

            return items;
        },
        render: () => {
            let component: VueRenderer;
            let popup: Instance[];

            return {
                onStart: (props) => {
                    component = new VueRenderer(WikiLinkSuggestion, {
                        props,
                        editor: props.editor,
                    });

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
                onUpdate: (props) => {
                    component.updateProps(props);
                    if (props.clientRect) {
                        popup[0].setProps({
                            getReferenceClientRect:
                                props.clientRect as () => DOMRect,
                        });
                    }
                },
                onKeyDown: (props) => {
                    if (props.event.key === 'Escape') {
                        popup[0].hide();
                        return true;
                    }
                    return component.ref?.onKeyDown(props.event) ?? false;
                },
                onExit: () => {
                    popup[0].destroy();
                    component.destroy();
                },
            };
        },
        command: ({ editor, range, props: item }) => {
            if (item.isCreate) {
                fetch('/api/nodes', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                    body: JSON.stringify({ content: item.content }),
                })
                    .then((res) => res.json())
                    .then((node) => {
                        editor
                            .chain()
                            .focus()
                            .deleteRange(range)
                            .insertContent({
                                type: 'mention',
                                attrs: { id: node.id, label: item.content },
                            })
                            .insertContent(' ')
                            .run();
                    });
            } else {
                editor
                    .chain()
                    .focus()
                    .deleteRange(range)
                    .insertContent({
                        type: 'mention',
                        attrs: { id: item.id, label: item.content },
                    })
                    .run();
            }
        },
    };
}
