import { eventMatchesKeyBinding } from './keyBindings';
import type { KeyBindingCommand, KeyBindings } from './keyBindings';

export class KeySequenceMatcher {
    private pending: { command: KeyBindingCommand; stroke: string }[] = [];
    private expiresAt = 0;
    private target: EventTarget | null = null;

    reset(): void {
        this.pending = [];
        this.target = null;
        this.expiresAt = 0;
    }

    match(
        event: KeyboardEvent,
        bindings: KeyBindings,
        editing: boolean,
        now = performance.now(),
    ): { commands: Set<KeyBindingCommand>; prefix: boolean } {
        const commands = new Set<KeyBindingCommand>();

        if (event.isComposing || event.getModifierState?.('AltGraph')) {
            this.reset();

            return { commands, prefix: false };
        }

        if (editing || now > this.expiresAt || event.target !== this.target) {
            this.reset();
        }

        if (this.pending.length > 0) {
            if (event.repeat) {
                return { commands, prefix: true };
            }

            for (const candidate of this.pending) {
                if (eventMatchesKeyBinding(event, candidate.stroke)) {
                    commands.add(candidate.command);
                }
            }

            this.reset();

            if (commands.size > 0) {
                return { commands, prefix: false };
            }
        }

        for (const [command, binding] of Object.entries(bindings) as [
            KeyBindingCommand,
            string | null,
        ][]) {
            if (!binding) {
                continue;
            }

            const strokes = binding.split(' ');

            if (
                strokes.length === 1 &&
                eventMatchesKeyBinding(event, binding)
            ) {
                commands.add(command);
            } else if (
                !editing &&
                !event.repeat &&
                strokes.length === 2 &&
                eventMatchesKeyBinding(event, strokes[0])
            ) {
                this.pending.push({ command, stroke: strokes[1] });
            }
        }

        if (this.pending.length > 0) {
            this.expiresAt = now + 1500;
            this.target = event.target;
        }

        return { commands, prefix: this.pending.length > 0 };
    }
}
