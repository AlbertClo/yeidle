import type { AppContext } from '../../context';
import type { WorkspaceRecord } from '../../workspaces';

import { RoamAttachmentImporter } from './attachments';
import type { RoamAttachmentFetcher } from './attachments';
import { RoamImporter } from './importer';
import type { RoamProgress } from './importer';
import { RoamImportError } from './report';
import type { RoamImportReport } from './report';

export type ImportRoamFileOptions = {
    /** Analyse and validate without writing data or downloading attachments. */
    dryRun?: boolean;
    /** Preserve Roam upload URLs instead of downloading them. */
    withoutFiles?: boolean;
    /** Import into an existing local workspace id. */
    workspace?: string | null;
    /** Create, activate, and import into a new local workspace. */
    newWorkspace?: string | null;
    progress?: RoamProgress | null;
    fetcher?: RoamAttachmentFetcher;
};

export type ImportRoamFileResult = {
    /** Null for a dry run. */
    workspace: WorkspaceRecord | null;
    workspaceId: string;
    workspaceName: string;
    report: RoamImportReport;
    /** The CLI's exit status: failed attachments fail the command. */
    success: boolean;
};

/**
 * The `roam:import` command without its console: unlike the import dialog,
 * it activates the target workspace (the default is the active one).
 */
export async function importRoamFile(
    ctx: AppContext,
    path: string,
    options: ImportRoamFileOptions = {},
): Promise<ImportRoamFileResult> {
    const dryRun = options.dryRun ?? false;

    if (options.workspace && options.newWorkspace) {
        throw new RoamImportError(
            'Use either --workspace or --new-workspace, not both.',
        );
    }

    let workspace: WorkspaceRecord | null = null;
    let workspaceId: string;
    let workspaceName: string;

    if (dryRun) {
        workspaceName = (options.newWorkspace || 'selected workspace').trim();
        workspaceId = `dry-run:${workspaceName}`;
    } else {
        workspace = options.newWorkspace
            ? ctx.workspaces.create(options.newWorkspace)
            : options.workspace
              ? ctx.workspaces.find(options.workspace)
              : ctx.workspace().record;
        ctx.workspaces.activate(workspace.id);
        workspaceId = workspace.id;
        workspaceName = workspace.name;
    }

    const importer = new RoamImporter(
        ctx,
        new RoamAttachmentImporter(ctx, options.fetcher),
    );
    const report = await importer.import(path, {
        dryRun,
        downloadAttachments: !options.withoutFiles,
        workspaceId,
        progress: options.progress,
    });

    return {
        workspace,
        workspaceId,
        workspaceName,
        report,
        success: report.attachmentsFailed === 0,
    };
}
