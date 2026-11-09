import { LoroDoc } from 'loro-crdt';
import { describe, expect, it } from 'vitest';

import {
    applyUnits,
    configureTextStyles,
    contentToUnits,
    readUnits,
    unitsToContent,
} from './richText';
import type { JsonNode, TiptapContent } from './richText';

function docWithText(): LoroDoc {
    const doc = new LoroDoc();
    configureTextStyles(doc);

    return doc;
}

function roundTrip(content: TiptapContent): TiptapContent {
    const doc = docWithText();
    const text = doc.getText('t');
    applyUnits(text, contentToUnits(content));
    doc.commit();

    return unitsToContent(readUnits(text));
}

function setContent(doc: LoroDoc, content: TiptapContent): void {
    applyUnits(doc.getText('t'), contentToUnits(content));
    doc.commit();
}

function getContent(doc: LoroDoc): TiptapContent {
    return unitsToContent(readUnits(doc.getText('t')));
}

type Mark = NonNullable<JsonNode['marks']>[number];

const paragraph = (...content: JsonNode[]): JsonNode => ({
    type: 'paragraph',
    content,
});
const text = (value: string, marks?: Mark[]): JsonNode =>
    marks
        ? { type: 'text', text: value, marks }
        : { type: 'text', text: value };

describe('rich text encoding', () => {
    it.each([
        ['a plain paragraph', paragraph(text('hello world'))],
        ['an empty paragraph', { type: 'paragraph' }],
        [
            'marks with and without attrs',
            paragraph(
                text('bold', [{ type: 'bold' }]),
                text(' and '),
                text('both', [{ type: 'bold' }, { type: 'italic' }]),
                text(' link', [
                    { type: 'link', attrs: { href: 'https://x.test' } },
                ]),
            ),
        ],
        [
            'inline atoms',
            paragraph(
                text('see '),
                {
                    type: 'mention',
                    attrs: { id: 'p1', label: 'Page One' },
                },
                text(' at '),
                { type: 'webLink', attrs: { href: 'https://a.test' } },
                { type: 'hardBreak' },
                text('next line'),
            ),
        ],
        [
            'a heading with attrs',
            { type: 'heading', attrs: { level: 2 }, content: [text('Title')] },
        ],
        [
            'a code block keeps newlines',
            {
                type: 'codeBlock',
                attrs: { language: 'php' },
                content: [text('<?php\necho 1;\n')],
            },
        ],
        [
            'several blocks',
            [
                paragraph(text('one')),
                {
                    type: 'fileNode',
                    attrs: { mediaId: 'm1', originalName: 'a.png' },
                },
                {
                    type: 'blockquote',
                    content: [paragraph(text('quoted'))],
                },
                { type: 'horizontalRule' },
                paragraph(text('two')),
            ],
        ],
        ['emoji code points', paragraph(text('a 😀 b'))],
    ])('round-trips %s', (_label, content) => {
        expect(roundTrip(content as TiptapContent)).toEqual(content);
    });

    it('stores null content as an empty text', () => {
        expect(roundTrip(null)).toBeNull();
    });

    it('drops reserved characters from typed text', () => {
        expect(roundTrip(paragraph(text('a b￼')))).toEqual(
            paragraph(text('a\nb')),
        );
    });
});

describe('minimal rich text edits', () => {
    it('leaves an unchanged text untouched', () => {
        const doc = docWithText();
        setContent(doc, paragraph(text('same')));
        const version = doc.version().toJSON();

        expect(
            applyUnits(
                doc.getText('t'),
                contentToUnits(paragraph(text('same'))),
            ),
        ).toBe(false);
        doc.commit();
        expect(doc.version().toJSON()).toEqual(version);
    });

    it('merges concurrent typing at both ends of a block', () => {
        const a = docWithText();
        a.setPeerId(1);
        setContent(a, paragraph(text('middle')));
        const b = docWithText();
        b.setPeerId(2);
        b.import(a.export({ mode: 'snapshot' }));

        setContent(a, paragraph(text('start middle')));
        setContent(b, paragraph(text('middle end')));
        a.import(b.export({ mode: 'update' }));
        b.import(a.export({ mode: 'update' }));

        expect(getContent(a)).toEqual(paragraph(text('start middle end')));
        expect(getContent(b)).toEqual(getContent(a));
    });

    it('merges formatting with concurrent typing', () => {
        const a = docWithText();
        a.setPeerId(1);
        setContent(a, paragraph(text('one two')));
        const b = docWithText();
        b.setPeerId(2);
        b.import(a.export({ mode: 'snapshot' }));

        setContent(a, paragraph(text('one', [{ type: 'bold' }]), text(' two')));
        setContent(b, paragraph(text('one two three')));
        a.import(b.export({ mode: 'update' }));

        expect(getContent(a)).toEqual(
            paragraph(text('one', [{ type: 'bold' }]), text(' two three')),
        );
    });

    it('does not let inserted text inherit neighbouring marks', () => {
        const doc = docWithText();
        setContent(doc, paragraph(text('bold', [{ type: 'bold' }])));
        setContent(
            doc,
            paragraph(text('bold', [{ type: 'bold' }]), text(' plain')),
        );

        expect(getContent(doc)).toEqual(
            paragraph(text('bold', [{ type: 'bold' }]), text(' plain')),
        );
    });

    it('changes block type without retyping the text', () => {
        const doc = docWithText();
        setContent(doc, paragraph(text('Title')));
        setContent(doc, {
            type: 'heading',
            attrs: { level: 1 },
            content: [text('Title')],
        });

        expect(getContent(doc)).toEqual({
            type: 'heading',
            attrs: { level: 1 },
            content: [text('Title')],
        });
    });
});
