export type Node = {
    id: string;
    page_id?: string;
    parent_id: string | null;
    position: string;
    content: string;
    tiptap_content: Record<string, unknown> | Record<string, unknown>[] | null;
    is_checked: boolean | null;
    modified_hlc: string;
    created_at: string;
    updated_at: string;
    children?: Node[];
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
