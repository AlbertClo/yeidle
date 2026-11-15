# Expressive names

## A class is named like the others of its kind

Every other exception ends in `Exception`.

```php
// Instead of
class GenerationRefused extends RuntimeException {}

// Use
class GenerationRefusedException extends RuntimeException {}
```

## A variable says what kind of thing it holds

```ts
// Instead of
const confirm = element('button', { type: 'button', textContent: 'Delete page' });
const use = document.getElementById('use');

// Use
const confirmButton = element('button', { type: 'button', textContent: 'Delete page' });
const useButton = document.getElementById('use');
```

## One thing has one name everywhere

In this codebase these are different things: a node is any block, a page is a top-level
node, and a document is the Loro document holding one page (or one hidden system root). Use the word for the thing
the code actually handles, and the same word in every file.

```ts
// Instead of
function reloadNode(pageId: string) {
    const doc = documents.get(pageId);

// Use
function reloadPage(pageId: string) {
    const document = documents.get(pageId);
```
