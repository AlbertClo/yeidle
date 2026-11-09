/** A problem with the export or the import that is safe to show the user. */
export class RoamImportError extends Error {}

export class RoamImportCancelled extends Error {
    constructor() {
        super('The Roam import was stopped.');
    }
}

export class RoamImportReport {
    pages = 0;
    blocks = 0;
    pageReferences = 0;
    blockReferences = 0;
    blockEmbeds = 0;
    attachments = 0;
    attachmentsImported = 0;
    attachmentsReused = 0;
    attachmentsFailed = 0;
    nodesWritten = 0;
    nodesAlreadyImported = 0;
    unresolvedPageReferences = 0;
    unresolvedBlockReferences = 0;
    unsupportedMacros = 0;
    warnings: string[] = [];

    hasFailures(): boolean {
        return (
            this.attachmentsFailed > 0 ||
            this.unresolvedPageReferences > 0 ||
            this.unresolvedBlockReferences > 0
        );
    }

    /** Labels are shown as-is by the import dialog. */
    summary(): Record<string, number> {
        return {
            Pages: this.pages,
            Blocks: this.blocks,
            'Page references': this.pageReferences,
            'Block references': this.blockReferences,
            'Block embeds': this.blockEmbeds,
            'Attachments found': this.attachments,
            'Attachments imported': this.attachmentsImported,
            'Attachments reused': this.attachmentsReused,
            'Attachments failed': this.attachmentsFailed,
            'Nodes written': this.nodesWritten,
            'Nodes already imported': this.nodesAlreadyImported,
            'Unresolved page references': this.unresolvedPageReferences,
            'Unresolved block references': this.unresolvedBlockReferences,
            'Unsupported macros preserved as text': this.unsupportedMacros,
        };
    }
}
