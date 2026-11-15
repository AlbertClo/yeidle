export type Node = {
    id: string;
    page_id?: string;
    parent_id: string | null;
    position: string;
    content: string;
    tiptap_content: Record<string, unknown> | Record<string, unknown>[] | null;
    is_checked: boolean | null;
    page_type?: 'daily_note' | null;
    daily_note_date?: string | null;
    modified_at: string;
    created_at: string;
    updated_at: string;
    children?: Node[];
};

/** A page as the core lists it. Timestamps are unix ms. */
export type Page = {
    id: string;
    title: string;
    kind: 'page' | 'daily';
    /** YYYY-MM-DD for daily notes. */
    daily_date: string | null;
    created_at: number;
    updated_at: number;
};

/** A search match: a page by its title, or a block by its text. */
export type SearchResult = {
    kind: 'page' | 'block';
    id: string;
    page_id: string;
    text: string;
};

/** A block with its children, as references and embeds show it. */
export type BlockTree = {
    id: string;
    text: string;
    children: BlockTree[];
};

export type NodeLink = {
    id: string;
    source_node_id: string;
    target_node_id: string;
    display_name: string | null;
    created_at: string;
    source_node?: Node;
    target_node?: Node;
};
