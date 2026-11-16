import { defineComponent, h, inject } from 'vue';
import type { InjectionKey, PropType, VNode } from 'vue';

/**
 * A block's rich text (TipTap JSON, as the editor stores it), rendered
 * read-only: formatting, web links (opened in the browser) and page links
 * (opened in the app). Unknown nodes fall back to their text.
 */

type JsonNode = {
    type?: string;
    text?: string;
    attrs?: Record<string, unknown>;
    marks?: { type: string; attrs?: Record<string, unknown> }[];
    content?: JsonNode[];
};

/** What a render step produces: text, an element, or several of them. */
type Child = string | VNode | Child[];

export type LinkHandlers = {
    openPage(id: string): void;
    openUrl(url: string): void;
};

export const LINK_HANDLERS: InjectionKey<LinkHandlers> =
    Symbol('link handlers');

const isWebUrl = (value: unknown): value is string =>
    typeof value === 'string' && /^https?:\/\//i.test(value);

export default defineComponent({
    name: 'RichContent',
    props: {
        content: {
            type: [Object, Array] as PropType<object | unknown[] | null>,
            default: null,
        },
        fallback: { type: String, default: '' },
    },
    setup(props) {
        const links = inject(LINK_HANDLERS, {
            openPage: () => undefined,
            openUrl: () => undefined,
        });

        const externalLink = (href: unknown, label: Child): Child =>
            isWebUrl(href)
                ? h(
                      'a',
                      {
                          href,
                          class: 'web-link',
                          onClick: (event: Event) => {
                              event.preventDefault();
                              links.openUrl(href);
                          },
                      },
                      [label],
                  )
                : label;

        const inline = (node: JsonNode): Child => {
            const attrs = node.attrs ?? {};

            switch (node.type) {
                case 'text': {
                    let child: Child = node.text ?? '';

                    for (const mark of node.marks ?? []) {
                        if (mark.type === 'bold') child = h('strong', [child]);
                        else if (mark.type === 'italic')
                            child = h('em', [child]);
                        else if (mark.type === 'code')
                            child = h('code', [child]);
                        else if (mark.type === 'strike')
                            child = h('s', [child]);
                        else if (mark.type === 'underline')
                            child = h('u', [child]);
                        else if (mark.type === 'link')
                            child = externalLink(mark.attrs?.href, child);
                    }

                    return child;
                }
                case 'hardBreak':
                    return h('br');
                case 'webLink':
                    return externalLink(
                        attrs.href,
                        String(attrs.label || attrs.href || ''),
                    );
                case 'mention': {
                    const id = attrs.id;
                    const label = `[[${String(attrs.label ?? id ?? '')}]]`;

                    return typeof id === 'string'
                        ? h(
                              'a',
                              {
                                  href: '#',
                                  class: 'page-link',
                                  onClick: (event: Event) => {
                                      event.preventDefault();
                                      links.openPage(id);
                                  },
                              },
                              label,
                          )
                        : label;
                }
                case 'blockReference':
                case 'blockEmbed':
                    return h(
                        'span',
                        { class: 'muted' },
                        `((${String(attrs.fallback ?? attrs.targetUid ?? '')}))`,
                    );
                case 'fileNode':
                    return h(
                        'span',
                        { class: 'muted' },
                        `[${String(attrs.originalName ?? 'File')}]`,
                    );
                default:
                    return (node.content ?? []).map(inline);
            }
        };

        const block = (node: JsonNode): VNode => {
            const children = (node.content ?? []).map(inline);

            switch (node.type) {
                case 'heading':
                    return h('strong', { class: 'heading' }, children);
                case 'codeBlock':
                    return h('pre', h('code', children));
                default:
                    return h('span', { class: 'paragraph' }, children);
            }
        };

        return () => {
            const content = props.content as JsonNode | JsonNode[] | null;
            const blocks = Array.isArray(content)
                ? content
                : content
                  ? [content]
                  : [];

            return blocks.length > 0
                ? h('span', { class: 'rich' }, blocks.map(block))
                : h('span', props.fallback);
        };
    },
});
