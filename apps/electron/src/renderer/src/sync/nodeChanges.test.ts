import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    LOCAL_NODES_CHANGED_EVENT,
    notifyLocalNodesChanged,
} from './nodeChanges';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('notifyLocalNodesChanged', () => {
    it('publishes unique changed node ids', () => {
        const localWindow = new EventTarget();
        const listener = vi.fn();
        localWindow.addEventListener(LOCAL_NODES_CHANGED_EVENT, listener);
        vi.stubGlobal('window', localWindow);

        notifyLocalNodesChanged(['a', 'b', 'a']);

        expect(listener).toHaveBeenCalledOnce();
        expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
            ids: ['a', 'b'],
        });
    });
});
