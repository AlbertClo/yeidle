/**
 * Editing commands sent to the page editor from outside it: the command
 * palette, and the touch toolbar on phones (where there's no Tab key).
 */

export const NODE_COMMAND_EVENT = 'yeidle:node-command';

export type NodeCommand =
    | 'move-node-up'
    | 'move-node-down'
    | 'indent'
    | 'outdent'
    | 'toggle-checkbox'
    | 'undo'
    | 'redo';

export function runNodeCommand(command: NodeCommand): void {
    window.dispatchEvent(
        new CustomEvent(NODE_COMMAND_EVENT, { detail: command }),
    );
}
