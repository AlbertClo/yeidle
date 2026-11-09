export const OPEN_CLOUD_ACCOUNT_EVENT = 'yeidle:open-cloud-account';

export function openCloudAccount(): void {
    window.dispatchEvent(new CustomEvent(OPEN_CLOUD_ACCOUNT_EVENT));
}
