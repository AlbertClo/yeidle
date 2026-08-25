export type Workspace = {
    id: string;
    name: string;
    database: string;
};

export type WorkspaceState = {
    active_workspace_id: string;
    workspaces: Workspace[];
};
