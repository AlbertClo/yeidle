import { mergeAttributes, Node, inputRuleFromRegExp } from '@tiptap/core';

// Match URLs typed followed by a space
const URL_REGEX = /(?:https?:\/\/)[^\s]+/;
const URL_INPUT_REGEX = /((?:https?:\/\/)[^\s]+)\s$/;

export const WebLink = Node.create({
    name: 'webLink',
    group: 'inline',
    inline: true,
    atom: true,

    addAttributes() {
        return {
            href: {
                default: null,
            },
            label: {
                default: null,
            },
        };
    },

    parseHTML() {
        return [{ tag: 'a[data-web-link]' }];
    },

    renderHTML({ node, HTMLAttributes }) {
        return [
            'a',
            mergeAttributes(HTMLAttributes, {
                'data-web-link': '',
                href: node.attrs.href,
                class: 'web-link',
                target: '_blank',
                rel: 'noopener noreferrer',
            }),
            node.attrs.label || node.attrs.href,
        ];
    },

    renderText({ node }) {
        return node.attrs.label || node.attrs.href;
    },

    addInputRules() {
        return [
            {
                find: URL_INPUT_REGEX,
                handler: ({ state, range, match }) => {
                    const href = match[1];
                    const { tr } = state;

                    const node = this.type.create({ href });
                    tr.replaceWith(range.from, range.to, node);
                    tr.insertText(' ');
                },
            },
        ];
    },

    addKeyboardShortcuts() {
        return {
            Backspace: () =>
                this.editor.commands.command(({ tr, state }) => {
                    const { $from } = state.selection;
                    const nodeBefore = $from.nodeBefore;
                    if (nodeBefore?.type.name === this.name) {
                        // Convert back to editable text instead of deleting
                        const pos = $from.pos - nodeBefore.nodeSize;
                        tr.replaceWith(pos, $from.pos, state.schema.text(nodeBefore.attrs.href));
                        return true;
                    }
                    return false;
                }),
        };
    },
});
