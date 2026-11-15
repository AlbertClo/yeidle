# Use standard functions

## Loro: a cursor already follows its character through edits

A remote caret stored as an offset has to be shifted by hand for every insert and
delete before it. A Loro cursor points at a character, and Loro works out its current
offset.

```ts
// Instead of
let caretOffset = 6;

function shiftCaret(insertedAt: number, length: number) {
    if (insertedAt <= caretOffset) {
        caretOffset += length;
    }
}

// Use
const cursor = text.getCursor(6);
const caretOffset = doc.getCursorPos(cursor)?.offset;
```

## Vue: VueUse is installed and already used across the frontend

```ts
// Instead of
const copied = ref(false);

async function copyToClipboard(text: string) {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
}

// Use
const { copy, copied } = useClipboard();
```

## Laravel: validation already rejects duplicates in a list

```php
// Instead of
$validated = $request->validate([
    'updates.*.update_id' => ['required', 'string', 'max:64'],
]);

$ids = array_column($validated['updates'], 'update_id');

if (count($ids) !== count(array_unique($ids))) {
    abort(422, 'Update ids must be unique.');
}

// Use
$validated = $request->validate([
    'updates.*.update_id' => ['required', 'string', 'max:64', 'distinct'],
]);
```
