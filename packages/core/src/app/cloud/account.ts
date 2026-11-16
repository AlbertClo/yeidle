import type { AppContext } from '../context';
import { UserKeyBindings } from '../services/keyBindings';
import { WorkspaceError } from '../workspaces';
import type { WorkspaceRecord, WorkspaceState } from '../workspaces';

import { CloudError, cloudMessage, cloudRequest } from './http';
import type { CloudFetch } from './http';
import type { CloudSync, ConnectResult } from './sync';

/**
 * The signed-in Yeidle Cloud account (port of the PHP CloudAccountService).
 * Sign-in is the device flow: the app asks the cloud for an authorization,
 * the user approves it in the browser, and the app collects a token. The
 * account (token, user, cloud workspace list) lives in cloud-account.json
 * in the app data directory.
 */

type CloudWorkspace = {
    id: string;
    name: string;
    role?: string;
    owned?: boolean;
};

type RealtimeSettings = {
    enabled: true;
    app_key: string;
    host: string;
    port: number;
    scheme: 'http' | 'https';
};

type StoredAccount = {
    cloud_url: string;
    token: string;
    user: { id: string } & Record<string, unknown>;
    workspaces: CloudWorkspace[];
    preferences: { key_bindings?: unknown };
    /** Local key bindings not uploaded yet (saved while offline). */
    preferences_dirty?: boolean;
};

type PendingAuthorization = {
    id: string;
    secret: string;
    verification_url: string;
    expires_at: string;
    cloud_url: string;
    realtime: RealtimeSettings;
};

type AccountFile = {
    version: 1;
    account: StoredAccount | null;
    pending: PendingAuthorization | null;
};

const FILE = 'cloud-account.json';

export class CloudAccount {
    constructor(
        private ctx: AppContext,
        private fetchImpl: CloudFetch,
        private syncFor: () => CloudSync,
        private cloudUrl: string | null,
    ) {}

    status(): Record<string, unknown> {
        const { account, pending } = this.read();

        return {
            signed_in: account !== null,
            user: account?.user ?? null,
            workspaces: account?.workspaces ?? [],
            preferences: account?.preferences ?? { key_bindings: [] },
            authorization_pending: pending !== null,
            authorization_id: pending?.id ?? null,
            authorization_expires_at: pending?.expires_at ?? null,
            verification_url: pending?.verification_url ?? null,
            authorization_realtime: pending?.realtime ?? null,
        };
    }

    account(): StoredAccount | null {
        return this.read().account;
    }

    async begin(deviceName: string): Promise<Record<string, unknown>> {
        const url = this.requireCloudUrl();
        const response = await cloudRequest(
            this.fetchImpl,
            'POST',
            `${url}/api/device-authorizations`,
            { json: { device_name: deviceName.trim() }, timeoutMs: 15_000 },
        );

        if (response.status !== 201) {
            throw new CloudError(
                `Could not start sign in (HTTP ${response.status}).`,
                response.status,
            );
        }

        const body = response.body ?? {};
        const pending: PendingAuthorization = {
            id: body.id as string,
            secret: body.secret as string,
            verification_url: body.verification_url as string,
            expires_at: body.expires_at as string,
            cloud_url: url,
            realtime: validRealtime(body.realtime),
        };

        for (const key of [
            'id',
            'secret',
            'verification_url',
            'expires_at',
        ] as const) {
            if (typeof pending[key] !== 'string' || pending[key] === '') {
                throw new CloudError(
                    'Yeidle Cloud returned an invalid sign-in request.',
                );
            }
        }

        this.write({ pending });
        this.ctx.host.openExternal(pending.verification_url);

        return {
            status: 'pending',
            authorization_id: pending.id,
            verification_url: pending.verification_url,
            expires_at: pending.expires_at,
            realtime: pending.realtime,
        };
    }

    async completeAuthorization(): Promise<Record<string, unknown>> {
        const { pending } = this.read();

        if (pending === null) {
            throw new CloudError('No sign-in request is pending.');
        }

        const response = await cloudRequest(
            this.fetchImpl,
            'POST',
            `${pending.cloud_url}/api/device-authorizations/${pending.id}/token`,
            { json: { secret: pending.secret }, timeoutMs: 15_000 },
        );

        if (response.status === 202) {
            return { status: 'pending' };
        }

        if (response.status === 410) {
            this.write({ account: null, pending: null });

            return { status: 'expired' };
        }

        if (!response.ok) {
            throw new CloudError(
                `Could not finish sign in (HTTP ${response.status}).`,
                response.status,
            );
        }

        const body = response.body ?? {};
        const user = body.user as StoredAccount['user'] | undefined;

        if (
            typeof body.token !== 'string' ||
            body.token === '' ||
            typeof user?.id !== 'string' ||
            !Array.isArray(body.workspaces) ||
            body.preferences === null ||
            typeof body.preferences !== 'object'
        ) {
            throw new CloudError(
                'Yeidle Cloud returned an invalid account session.',
            );
        }

        const account: StoredAccount = {
            cloud_url: pending.cloud_url,
            token: body.token,
            user,
            workspaces: body.workspaces as CloudWorkspace[],
            preferences: body.preferences as StoredAccount['preferences'],
        };
        this.write({ account, pending: null });
        this.importKeyBindings(account.preferences);
        this.ctx.workspaces.syncCloudCatalog(user.id, account.workspaces);

        return { status: 'approved', ...this.status() };
    }

    async authorizePendingRealtime(
        socketId: string,
        channelName: string,
    ): Promise<Record<string, unknown>> {
        const { pending } = this.read();

        if (pending === null) {
            throw new CloudError('No sign-in request is pending.');
        }

        if (channelName !== `private-device-authorizations.${pending.id}`) {
            throw new CloudError(
                'The device authorization channel is not allowed.',
            );
        }

        const response = await cloudRequest(
            this.fetchImpl,
            'POST',
            `${pending.cloud_url}/api/device-authorizations/${pending.id}/broadcasting-auth`,
            {
                form: {
                    secret: pending.secret,
                    socket_id: socketId,
                    channel_name: channelName,
                },
                timeoutMs: 15_000,
            },
        );

        if (!response.ok || typeof response.body?.auth !== 'string') {
            throw new CloudError('Realtime sign-in authorization failed.');
        }

        return response.body;
    }

    cancelAuthorization(): void {
        this.write({ pending: null });
    }

    async refresh(): Promise<Record<string, unknown>> {
        const account = this.requireAccount();
        const workspaces = await this.request(
            account,
            'GET',
            '/api/workspaces',
        );
        // Local changes made offline win over the cloud copy
        const preferences = account.preferences_dirty
            ? await this.request(account, 'PUT', '/api/user/preferences', {
                  key_bindings: new UserKeyBindings(this.ctx).overrides(),
              })
            : await this.request(account, 'GET', '/api/user/preferences');

        if (
            [workspaces.status, preferences.status].some(
                (s) => s === 401 || s === 403,
            )
        ) {
            this.clearLocalAccount();

            throw new CloudError('Your Yeidle sign-in expired. Sign in again.');
        }

        if (!workspaces.ok || !Array.isArray(workspaces.body?.workspaces)) {
            throw new CloudError('Could not refresh cloud workspaces.');
        }

        account.workspaces = workspaces.body.workspaces as CloudWorkspace[];

        if (preferences.ok) {
            account.preferences = {
                key_bindings: preferences.body?.key_bindings ?? [],
            };
            account.preferences_dirty = false;
            this.importKeyBindings(account.preferences);
        }

        this.write({ account });
        this.ctx.workspaces.syncCloudCatalog(
            account.user.id,
            account.workspaces,
        );

        return this.status();
    }

    /** Pairs the active workspace with its cloud workspace and syncs it. */
    async syncActiveWorkspace(): Promise<
        | { synced: false; reason: string }
        | { synced: true; result: ConnectResult }
    > {
        const account = this.requireAccount();
        // The index, not the open workspace's record: enabling sync changes it
        const workspace = this.ctx.workspaces.find(
            this.ctx.workspaces.state().active_workspace_id,
        );

        if (workspace.cloud_status === 'local') {
            return { synced: false, reason: 'local' };
        }

        if (!account.workspaces.some((cloud) => cloud.id === workspace.id)) {
            this.ctx.workspaces.syncCloudCatalog(
                account.user.id,
                account.workspaces,
            );

            return { synced: false, reason: 'unavailable' };
        }

        this.ctx.workspaces.markCloudStatus(workspace.id, 'syncing');

        try {
            const result = await this.syncFor().connect(workspace.id);
            this.ctx.workspaces.markCloudStatus(workspace.id, 'ready');

            return { synced: true, result };
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            this.ctx.workspaces.markCloudStatus(workspace.id, 'error', message);

            throw error;
        }
    }

    /** Creates the cloud workspace for a local one (same id). */
    async enableWorkspaceSync(workspaceId: string): Promise<WorkspaceRecord> {
        const account = this.requireAccount();
        const local = this.ctx.workspaces.find(workspaceId);

        if (local.cloud_status !== 'local') {
            throw new CloudError(
                'This workspace is already connected to Yeidle Cloud.',
            );
        }

        const response = await this.request(
            account,
            'POST',
            '/api/workspaces',
            {
                id: workspaceId,
                name: local.name,
            },
        );
        const workspace = response.body?.workspace as
            CloudWorkspace | undefined;

        if (response.status !== 201 || typeof workspace?.id !== 'string') {
            throw new CloudError(
                cloudMessage(response, 'Could not create the cloud workspace'),
                response.status,
            );
        }

        this.replaceCloudWorkspace(account, workspace);

        return this.ctx.workspaces.find(workspaceId);
    }

    async renameWorkspace(
        workspaceId: string,
        name: string,
    ): Promise<WorkspaceRecord> {
        const account = this.requireAccount();

        if (this.ctx.workspaces.find(workspaceId).cloud_owned !== true) {
            throw new WorkspaceError('Only the workspace owner can rename it.');
        }

        const response = await this.request(
            account,
            'PATCH',
            `/api/workspaces/${workspaceId}`,
            { name: name.trim() },
        );
        const workspace = response.body?.workspace as
            CloudWorkspace | undefined;

        if (!response.ok || typeof workspace?.id !== 'string') {
            throw new CloudError(
                cloudMessage(response, 'Could not rename the cloud workspace'),
                response.status,
            );
        }

        this.replaceCloudWorkspace(account, workspace);

        return this.ctx.workspaces.find(workspaceId);
    }

    async deleteWorkspace(workspaceId: string): Promise<WorkspaceState> {
        if (this.ctx.workspaces.find(workspaceId).cloud_owned !== true) {
            throw new WorkspaceError('Only the workspace owner can delete it.');
        }

        const account = this.requireAccount();
        const response = await this.request(
            account,
            'DELETE',
            `/api/workspaces/${workspaceId}`,
        );

        if (!response.ok) {
            throw new CloudError(
                cloudMessage(response, 'Could not delete the cloud workspace'),
                response.status,
            );
        }

        account.workspaces = account.workspaces.filter(
            (workspace) => workspace.id !== workspaceId,
        );
        this.write({ account });

        return this.ctx.workspaces.delete(workspaceId);
    }

    /**
     * Uploads this user's key binding overrides. They are marked dirty first,
     * so an upload that fails is retried by the next refresh.
     */
    async saveKeyBindings(
        keyBindings: Record<string, string | null>,
    ): Promise<void> {
        const account = this.read().account;

        if (account === null) {
            return;
        }

        account.preferences = { key_bindings: keyBindings };
        account.preferences_dirty = true;
        this.write({ account });

        const response = await this.request(
            account,
            'PUT',
            '/api/user/preferences',
            { key_bindings: keyBindings },
        );
        const current = this.read().account;

        if (response.ok && current !== null) {
            current.preferences = {
                key_bindings: response.body?.key_bindings ?? keyBindings,
            };
            current.preferences_dirty = false;
            this.write({ account: current });
        }
    }

    async logout(): Promise<void> {
        const { account } = this.read();

        if (account !== null) {
            try {
                await this.request(account, 'DELETE', '/api/device');
            } catch {
                // Signing out locally must work offline
            }
        }

        this.clearLocalAccount();
    }

    private clearLocalAccount(): void {
        // The token only lives here, so syncing stops with it
        this.write({ account: null, pending: null });
    }

    private replaceCloudWorkspace(
        account: StoredAccount,
        workspace: CloudWorkspace,
    ): void {
        account.workspaces = [
            ...account.workspaces.filter(
                (existing) => existing.id !== workspace.id,
            ),
            workspace,
        ];
        this.write({ account });
        this.ctx.workspaces.syncCloudCatalog(
            account.user.id,
            account.workspaces,
        );
    }

    private importKeyBindings(preferences: StoredAccount['preferences']): void {
        const bindings = preferences.key_bindings;

        if (
            bindings !== null &&
            typeof bindings === 'object' &&
            !Array.isArray(bindings)
        ) {
            new UserKeyBindings(this.ctx).importCloud(
                bindings as Record<string, unknown>,
            );
        }
    }

    private request(
        account: StoredAccount,
        method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        path: string,
        json?: unknown,
    ) {
        return cloudRequest(
            this.fetchImpl,
            method,
            `${account.cloud_url}${path}`,
            {
                token: account.token,
                json,
                timeoutMs: 15_000,
            },
        );
    }

    private requireAccount(): StoredAccount {
        const account = this.read().account;

        if (account === null) {
            throw new CloudError('Sign in to Yeidle Cloud first.');
        }

        return account;
    }

    private requireCloudUrl(): string {
        const url = this.cloudUrl?.replace(/\/+$/, '') ?? '';

        if (!/^https?:\/\/.+/.test(url)) {
            throw new CloudError('Yeidle Cloud is not configured.');
        }

        return url;
    }

    private path(): string {
        return this.ctx.host.files.join(this.ctx.host.dataDirectory, FILE);
    }

    private read(): AccountFile {
        const files = this.ctx.host.files;

        try {
            if (files.exists(this.path())) {
                const data = JSON.parse(
                    files.readText(this.path()),
                ) as Partial<AccountFile>;

                return {
                    version: 1,
                    account: data.account ?? null,
                    pending: data.pending ?? null,
                };
            }
        } catch {
            // A damaged file reads as signed out
        }

        return { version: 1, account: null, pending: null };
    }

    private write(changes: Partial<Omit<AccountFile, 'version'>>): void {
        const files = this.ctx.host.files;
        const data = { ...this.read(), ...changes };
        files.mkdir(this.ctx.host.dataDirectory);
        files.writeFile(this.path(), `${JSON.stringify(data, null, 4)}\n`);
    }
}

function validRealtime(value: unknown): RealtimeSettings {
    const realtime = value as Record<string, unknown> | null;

    if (
        realtime?.enabled !== true ||
        typeof realtime.app_key !== 'string' ||
        realtime.app_key === '' ||
        typeof realtime.host !== 'string' ||
        realtime.host === '' ||
        typeof realtime.port !== 'number' ||
        realtime.port < 1 ||
        realtime.port > 65535 ||
        (realtime.scheme !== 'http' && realtime.scheme !== 'https')
    ) {
        throw new CloudError('Yeidle Cloud realtime sign in is unavailable.');
    }

    return {
        enabled: true,
        app_key: realtime.app_key,
        host: realtime.host,
        port: realtime.port,
        scheme: realtime.scheme,
    };
}
