export const NODE_COMMAND_EVENT = 'yeidle:node-command';
export type NodeCommand = 'move-node-up' | 'move-node-down';

export function runNodeCommand(command: NodeCommand): void {
    window.dispatchEvent(
        new CustomEvent(NODE_COMMAND_EVENT, { detail: command }),
    );
}
