# Use standard functions

## PHP: a backed enum already turns a string into its case

```php
// Instead of
public static function fromUploadedMediaType(string $mediaType): self
{
    return match ($mediaType) {
        'image' => self::IMAGE,
        'video' => self::VIDEO,
        'audio' => self::AUDIO,
    };
}

$kind = MediaKindEnum::fromUploadedMediaType($upload->mediaType->name);

// Use
$kind = MediaKindEnum::from($upload->mediaType->name);
```

## Laravel: a relation already adds and removes its own pivot rows

```php
// Instead of
public function removeFromProject(string $projectId): int
{
    return ProjectItem::query()
        ->where('item_type', $this->getMorphClass())
        ->where('item_id', $this->id)
        ->where('project_id', $projectId)
        ->delete();
}

$upload->removeFromProject($projectId);

// Use
$upload->projects()->detach($projectId);
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
