export type Workspace = {
    id: string;
    name: string;
    database: string;
    cloud_account_id: string | null;
    cloud_status: 'local' | 'available' | 'syncing' | 'ready' | 'error';
    cloud_role: string | null;
    cloud_owned: boolean | null;
    cloud_error: string | null;
};

export type WorkspaceState = {
    active_workspace_id: string;
    workspaces: Workspace[];
};
