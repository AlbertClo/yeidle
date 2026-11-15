# Expressive names

## A class is named like the others of its kind

Every other exception ends in `Exception`.

```php
// Instead of
class GenerationRefused extends RuntimeException {}

// Use
class GenerationRefusedException extends RuntimeException {}
```

## A name can't be mistaken for something next to it

In a tool's `handle()`, `$generation->request()` read like the tool's own `$request`, or
like one generation. The object starts generations, and the method returns a request that
has been checked.

```php
// Instead of
public function handle(Request $request, McpGeneration $generation): Response
{
    $generationRequest = $generation->request($user, $model, $params);
}

// Use
public function handle(Request $request, McpGeneration $generator): Response
{
    $generationRequest = $generator->checkedRequest($user, $model, $params);
}
```

## A name says what happened

The provider could not verify the media. Nobody rejected anything.

```php
// Instead of
'rejected' => $rejected,

// Use
'verification_failed' => $verificationFailed,
```

## A function name says who or what it acts on

```js
// Instead of
const send = async (app, text) => {

button.addEventListener('click', () => send(app, text));

// Use
const sendToAssistant = async (app, text) => {

button.addEventListener('click', () => sendToAssistant(app, text));
```

## A variable says what kind of thing it holds

```js
// Instead of
const confirm = element('button', { type: 'button', textContent: 'I confirm I have the rights' });
const retry = element('div', { className: 'actions' }, [
const use = document.getElementById('use');

// Use
const confirmButton = element('button', { type: 'button', textContent: 'I confirm I have the rights' });
const retryActions = element('div', { className: 'actions' }, [
const useButton = document.getElementById('use');
```

## One thing has one name everywhere

The tool was registered under its class name, `generate-asset-tool`, while its description
and the server instructions called it `generate_asset`.

```php
// Instead of
class GenerateAssetTool extends Tool

// Use
#[Name('generate_asset')]
class GenerateAssetTool extends Tool
```
