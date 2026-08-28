<script setup lang="ts">
import {
    Check,
    Cloud,
    ExternalLink,
    LoaderCircle,
    LogOut,
    X,
} from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    beginCloudSignIn,
    cancelCloudSignIn,
    cloudAccount,
    completeCloudSignIn,
    loadCloudAccount,
    refreshCloudAccount,
    signOutCloudAccount,
    syncActiveCloudWorkspace,
} from '@/stores/cloudAccount';
import { loadCloudSyncStatus } from '@/stores/cloudSyncStatus';
import {
    startDeviceAuthorizationRealtime,
    stopDeviceAuthorizationRealtime,
} from '@/sync/deviceAuthorization';
import { refreshRealtimeSync } from '@/sync/realtime';
import { OPEN_CLOUD_ACCOUNT_EVENT } from '@/ui/cloudAccount';

const FIRST_RUN_KEY = 'yeidle:onboarding-dismissed';
const ACCOUNT_REFRESHED_KEY = 'yeidle:account-refreshed';
const SIGN_IN_CONFIRMATION_KEY = 'yeidle:sign-in-confirmation';
const ACCOUNT_DIALOG_OPEN_KEY = 'yeidle:account-dialog-open';
const open = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const verificationUrl = ref<string | null>(null);
const justSignedIn = ref(false);
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let completionInFlight = false;
let completionQueued = false;

const pending = computed(
    () => cloudAccount.value?.authorization_pending === true,
);

const accountInitials = computed(() => {
    const name = cloudAccount.value?.user?.name?.trim();
    const nameParts = name?.split(/\s+/).filter(Boolean) ?? [];

    if (nameParts.length >= 2) {
        return `${nameParts[0]?.[0] ?? ''}${nameParts.at(-1)?.[0] ?? ''}`.toUpperCase();
    }

    return cloudAccount.value?.user?.email?.[0]?.toUpperCase() ?? '';
});

function stopAuthorizationListener(): void {
    stopDeviceAuthorizationRealtime();

    if (expiryTimer !== null) {
        clearTimeout(expiryTimer);
        expiryTimer = null;
    }
}

async function completeSignIn(): Promise<void> {
    if (!pending.value) {
        return;
    }

    if (completionInFlight) {
        completionQueued = true;

        return;
    }

    completionInFlight = true;
    completionQueued = false;
    busy.value = true;

    try {
        const result = await completeCloudSignIn();

        if (result.status === 'approved') {
            stopAuthorizationListener();
            localStorage.setItem(FIRST_RUN_KEY, 'true');
            sessionStorage.setItem(SIGN_IN_CONFIRMATION_KEY, 'true');
            sessionStorage.setItem(ACCOUNT_DIALOG_OPEN_KEY, 'true');
            justSignedIn.value = true;
            open.value = true;
            toast.success('Signed in to Yeidle.');

            try {
                await syncActiveCloudWorkspace();
                await Promise.all([
                    refreshRealtimeSync(),
                    loadCloudSyncStatus(),
                ]);
            } catch {
                // Other workspaces remain visible and this one can retry on open.
            }
        } else if (result.status === 'expired') {
            stopAuthorizationListener();
            error.value = 'The sign-in request expired. Please try again.';
        }
    } catch (reason) {
        error.value =
            reason instanceof Error
                ? reason.message
                : 'Could not finish sign in.';
    } finally {
        const shouldRetry = completionQueued && pending.value;

        completionInFlight = false;
        completionQueued = false;
        busy.value = false;

        if (shouldRetry) {
            void completeSignIn();
        }
    }
}

function startAuthorizationListener(
    authorizationId: string,
    expiresAt: string,
    realtime: NonNullable<typeof cloudAccount.value>['authorization_realtime'],
): void {
    if (!realtime) {
        error.value = 'Realtime sign in is unavailable.';

        return;
    }

    stopAuthorizationListener();
    startDeviceAuthorizationRealtime(authorizationId, realtime, {
        approved: () => void completeSignIn(),
        subscribed: () => {
            error.value = null;
            void completeSignIn();
        },
        error: (message) => {
            error.value = message;
        },
    });

    const remaining = new Date(expiresAt).getTime() - Date.now();

    if (!Number.isFinite(remaining) || remaining <= 0) {
        void expireAuthorization();

        return;
    }

    expiryTimer = setTimeout(() => void expireAuthorization(), remaining);
}

function resumePendingAuthorization(): void {
    const account = cloudAccount.value;

    if (
        !account?.authorization_pending ||
        !account.authorization_id ||
        !account.authorization_expires_at
    ) {
        return;
    }

    startAuthorizationListener(
        account.authorization_id,
        account.authorization_expires_at,
        account.authorization_realtime,
    );
}

async function expireAuthorization(): Promise<void> {
    stopAuthorizationListener();

    try {
        await cancelCloudSignIn();
    } catch {
        // The local expiry state should still be reflected in the dialog.
    } finally {
        error.value = 'The sign-in request expired. Please try again.';
    }
}

async function signIn(): Promise<void> {
    if (busy.value) {
        return;
    }

    busy.value = true;
    error.value = null;
    justSignedIn.value = false;

    try {
        const result = await beginCloudSignIn();
        verificationUrl.value = result.verification_url ?? null;

        if (
            !result.authorization_id ||
            !result.expires_at ||
            !result.realtime
        ) {
            throw new Error(
                'Yeidle Cloud returned an invalid sign-in request.',
            );
        }

        startAuthorizationListener(
            result.authorization_id,
            result.expires_at,
            result.realtime,
        );
    } catch (reason) {
        error.value =
            reason instanceof Error
                ? reason.message
                : 'Could not start sign in.';
    } finally {
        busy.value = false;
    }
}

async function cancelSignIn(): Promise<void> {
    if (busy.value) {
        return;
    }

    busy.value = true;
    error.value = null;
    stopAuthorizationListener();

    try {
        await cancelCloudSignIn();
        verificationUrl.value = null;
    } catch (reason) {
        error.value =
            reason instanceof Error
                ? reason.message
                : 'Could not cancel sign in.';

        resumePendingAuthorization();
    } finally {
        busy.value = false;
    }
}

async function openApprovalPage(): Promise<void> {
    if (!verificationUrl.value) {
        return;
    }

    await fetch('/api/open-external', {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: verificationUrl.value }),
    });
}

async function refresh(): Promise<void> {
    busy.value = true;
    error.value = null;

    try {
        await refreshCloudAccount();
        toast.success('Cloud account refreshed.');
    } catch (reason) {
        error.value =
            reason instanceof Error
                ? reason.message
                : 'Could not refresh account.';
    } finally {
        busy.value = false;
    }
}

async function signOut(): Promise<void> {
    busy.value = true;

    try {
        await signOutCloudAccount();
        toast.success('Signed out of Yeidle Cloud.');
    } catch (reason) {
        error.value =
            reason instanceof Error ? reason.message : 'Could not sign out.';
    } finally {
        busy.value = false;
    }
}

function continueOffline(): void {
    localStorage.setItem(FIRST_RUN_KEY, 'true');
    closeDialog();
}

function setOpen(value: boolean): void {
    if (value) {
        sessionStorage.setItem(ACCOUNT_DIALOG_OPEN_KEY, 'true');
        open.value = true;
    }
}

function closeDialog(): void {
    sessionStorage.removeItem(ACCOUNT_DIALOG_OPEN_KEY);
    open.value = false;

    if (justSignedIn.value) {
        sessionStorage.removeItem(SIGN_IN_CONFIRMATION_KEY);
        justSignedIn.value = false;
    }
}

function dismissSignInConfirmation(): void {
    sessionStorage.removeItem(SIGN_IN_CONFIRMATION_KEY);
    justSignedIn.value = false;
    closeDialog();
}

function show(): void {
    error.value = null;
    justSignedIn.value = false;
    sessionStorage.setItem(ACCOUNT_DIALOG_OPEN_KEY, 'true');
    open.value = true;
}

watch(pending, (value) => {
    if (!value) {
        stopAuthorizationListener();
    }
});

onMounted(async () => {
    window.addEventListener(OPEN_CLOUD_ACCOUNT_EVENT, show);

    try {
        const account = await loadCloudAccount();
        verificationUrl.value = account.verification_url;

        if (sessionStorage.getItem(ACCOUNT_DIALOG_OPEN_KEY) === 'true') {
            open.value = true;
        }

        if (
            account.signed_in &&
            sessionStorage.getItem(SIGN_IN_CONFIRMATION_KEY) === 'true'
        ) {
            justSignedIn.value = true;
            open.value = true;
        }

        if (account.authorization_pending) {
            resumePendingAuthorization();
        }

        if (
            account.signed_in &&
            sessionStorage.getItem(ACCOUNT_REFRESHED_KEY) !== 'true'
        ) {
            sessionStorage.setItem(ACCOUNT_REFRESHED_KEY, 'true');
            void refreshCloudAccount().catch(() => loadCloudAccount(true));
        }

        if (
            !account.signed_in &&
            localStorage.getItem(FIRST_RUN_KEY) !== 'true'
        ) {
            sessionStorage.setItem(ACCOUNT_DIALOG_OPEN_KEY, 'true');
            open.value = true;
        }
    } catch {
        // Offline-first startup should not be blocked by account UI.
    }
});

onBeforeUnmount(() => {
    stopAuthorizationListener();
    window.removeEventListener(OPEN_CLOUD_ACCOUNT_EVENT, show);
});
</script>

<template>
    <Dialog :open="open" @update:open="setOpen">
        <DialogContent
            class="sm:max-w-md"
            :show-close-button="false"
            @open-auto-focus="$event.preventDefault()"
            @interact-outside="$event.preventDefault()"
        >
            <button
                type="button"
                aria-label="Close"
                class="absolute top-2 right-2 z-10 rounded-xs opacity-70 hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background focus:outline-hidden"
                @click="closeDialog"
            >
                <X class="size-4" />
            </button>
            <DialogHeader>
                <DialogTitle>
                    {{
                        justSignedIn
                            ? 'Signed in to Yeidle Cloud'
                            : cloudAccount?.signed_in
                              ? 'Yeidle account'
                              : 'Sign in'
                    }}
                </DialogTitle>
                <DialogDescription v-if="cloudAccount?.signed_in">
                    Your workspaces and keyboard shortcuts are available on this
                    device.
                </DialogDescription>
                <DialogDescription v-else>
                    Sign in to Yeidle Cloud to see every workspace you own or
                    that has been shared with you. You can also keep using
                    Yeidle entirely offline.
                </DialogDescription>
            </DialogHeader>

            <div v-if="cloudAccount?.signed_in" class="space-y-4">
                <div class="flex items-center gap-3 rounded-md border p-4">
                    <div
                        class="flex size-10 shrink-0 items-center justify-center rounded-sm bg-muted text-sm font-medium text-foreground"
                    >
                        {{ accountInitials }}
                    </div>
                    <div class="min-w-0 truncate text-sm">
                        {{ cloudAccount.user?.email }}
                    </div>
                </div>
                <div
                    class="flex items-start gap-3 rounded-md bg-muted/50 p-3 text-sm"
                >
                    <Check class="mt-0.5 size-4 shrink-0 text-[var(--link)]" />
                    <span>
                        {{ cloudAccount.workspaces.length }}
                        {{
                            cloudAccount.workspaces.length === 1
                                ? 'workspace is'
                                : 'workspaces are'
                        }}
                        available. Workspace contents download when you open
                        them.
                    </span>
                </div>
            </div>

            <div v-else-if="pending" class="space-y-4">
                <div class="flex items-start gap-3 rounded-md border p-4">
                    <LoaderCircle class="mt-0.5 size-5 shrink-0 animate-spin" />
                    <div>
                        <div class="font-medium">
                            Finish signing in in your browser
                        </div>
                        <p class="mt-1 text-sm text-muted-foreground">
                            This window will update automatically after you
                            approve this device.
                        </p>
                    </div>
                </div>
                <div class="flex items-center justify-between gap-4">
                    <button
                        v-if="verificationUrl"
                        type="button"
                        class="flex cursor-pointer items-center gap-2 text-sm text-[var(--link)] hover:underline"
                        @click="openApprovalPage"
                    >
                        Open approval page <ExternalLink class="size-3.5" />
                    </button>
                    <Button
                        variant="ghost"
                        class="ml-auto"
                        :disabled="busy"
                        @click="cancelSignIn"
                    >
                        Cancel
                    </Button>
                </div>
            </div>

            <div
                v-else
                class="flex items-start gap-3 rounded-md bg-muted/50 p-4 text-sm"
            >
                <Cloud class="mt-0.5 size-5 shrink-0" />
                <span>
                    A browser window will open. Log in or create an account,
                    then approve this device.
                </span>
            </div>

            <p v-if="error" class="text-sm text-destructive" role="alert">
                {{ error }}
            </p>

            <DialogFooter v-if="justSignedIn">
                <Button @click="dismissSignInConfirmation">Done</Button>
            </DialogFooter>
            <DialogFooter
                v-else-if="cloudAccount?.signed_in"
                class="sm:justify-between"
            >
                <Button variant="ghost" :disabled="busy" @click="signOut">
                    <LogOut /> Sign out
                </Button>
                <Button variant="outline" :disabled="busy" @click="refresh">
                    <LoaderCircle v-if="busy" class="animate-spin" />
                    Refresh account
                </Button>
            </DialogFooter>
            <DialogFooter v-else-if="!pending" class="sm:justify-between">
                <Button
                    variant="ghost"
                    :disabled="busy"
                    @click="continueOffline"
                >
                    Continue offline
                </Button>
                <Button :disabled="busy" @click="signIn">
                    <LoaderCircle v-if="busy" class="animate-spin" />
                    Sign in
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>
