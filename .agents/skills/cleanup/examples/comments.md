# Comments

## A comment doesn't compare the code with what it replaced

The PHP app is gone, so a reader can't look up what it did here.

```ts
// Instead of
// The PHP app refreshed cloud_user_id from the cloud here when paired but
// unknown; cloud sync is not ported yet, so the stored value is used as is.
return state;

// Use
// Pairing a workspace with the cloud records cloud_user_id (CloudSync.connect)
return state;
```

## A comment changes when the code it describes does

Cloud accounts were ported, and the function started returning the signed-in user's
profile. The comment kept describing the stub.

```ts
// Instead of
/**
 * Seam for the cloud account: bindings were scoped to `cloud:<user id>` when
 * signed in. Cloud accounts aren't ported yet, so everything is `local`.
 */
export function keyBindingProfileKey(ctx: AppContext): string {
    return cloudProfileKey(ctx);
}

// Use
/** Bindings belong to the signed-in cloud user (`cloud:<id>`), else `local`. */
export function keyBindingProfileKey(ctx: AppContext): string {
    return cloudProfileKey(ctx);
}
```
