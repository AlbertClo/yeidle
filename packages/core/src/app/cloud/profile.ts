import type { AppContext } from '../context';
import { syncIdentity } from '../services/accountRoots';

import { cloudFor } from './index';

/**
 * Whose key bindings and navigation history are in use: `cloud:<user id>`
 * while signed in (or while the workspace is paired with a cloud user),
 * otherwise `local`. Switching accounts switches both.
 */
export function cloudProfileKey(ctx: AppContext): string {
    const accountUserId = cloudFor(ctx).account.account()?.user.id;

    if (accountUserId !== undefined && accountUserId !== null) {
        const id = String(accountUserId);

        if (id !== '') {
            return `cloud:${id}`;
        }
    }

    const cloudUserId = syncIdentity(ctx.db()).cloud_user_id;

    return typeof cloudUserId === 'string' && cloudUserId !== ''
        ? `cloud:${cloudUserId}`
        : 'local';
}
