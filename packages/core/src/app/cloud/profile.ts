import { Meta } from '../../db/meta';
import type { AppContext } from '../context';

import { cloudFor } from './index';

/**
 * Whose personal data is in use (key bindings, navigation history, the user
 * document): `cloud:<user id>` while signed in (or while the workspace is
 * paired with a cloud user), otherwise `local`. Switching accounts switches
 * all of it.
 */
export function cloudProfileKey(ctx: AppContext): string {
    const accountUserId = cloudFor(ctx).account.account()?.user.id;

    if (accountUserId !== undefined && accountUserId !== null) {
        const id = String(accountUserId);

        if (id !== '') {
            return `cloud:${id}`;
        }
    }

    const pairedUserId = new Meta(ctx.db()).get('cloud_user_id');

    return pairedUserId !== null && pairedUserId !== ''
        ? `cloud:${pairedUserId}`
        : 'local';
}
