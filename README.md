# svelte-webmcp

Register [WebMCP](https://github.com/webmachinelearning/webmcp) tools from Svelte 5, with registration
tied to the component lifecycle.

WebMCP lets a page hand AI agents a set of callable functions instead of making them scrape the DOM,
read the accessibility tree, or work off screenshots. The browser exposes `document.modelContext`,
the page registers tools with a name, a description, a JSON Schema, and an `execute`, and any agent
that can see the page can discover and call them.

This is a Svelte port of [`use-webmcp-tool`](https://github.com/GoogleChromeLabs/use-webmcp-tool),
the React hook Chrome maintains.

## Install

```sh
npm install svelte-webmcp
```

Svelte 5 is the only peer dependency. There are no runtime dependencies.

## Use

```svelte
<script lang="ts">
	import { WebMCPTool } from 'svelte-webmcp';

	let todos = $state<{ text: string; done: boolean }[]>([]);

	const tool = new WebMCPTool<{ text: string }>({
		name: 'add_todo',
		description: "Add an item to the user's todo list",
		inputSchema: {
			type: 'object',
			properties: { text: { type: 'string' } },
			required: ['text']
		},
		execute({ text }) {
			todos.push({ text, done: false });
			return `Added "${text}"`;
		}
	});
</script>

{#if tool.supported}
	<p>{tool.registered ? 'Agent tools ready' : '…'}</p>
{/if}
```

The tool registers when the component mounts and unregisters when it is destroyed, so the set of
tools an agent discovers stays in lockstep with what is actually on screen. Construct it during
component initialisation, or inside an `$effect.root`.

The raw API is imperative and you unregister by aborting a signal. `WebMCPTool` wraps that.

```js
const controller = new AbortController();
document.modelContext.registerTool(
	{ name, description, inputSchema, execute },
	{
		signal: controller.signal
	}
);
controller.abort(); // unregister
```

## Options

| Option         | Type                                       | Notes                                          |
| -------------- | ------------------------------------------ | ---------------------------------------------- |
| `name`         | `string`                                   | Required. Changing it re-registers the tool.   |
| `description`  | `string`                                   | Required. What the agent reads to decide.      |
| `inputSchema`  | `object`                                   | JSON Schema for `execute`'s argument object.   |
| `annotations`  | `{ readOnlyHint?, untrustedContentHint? }` |                                                |
| `enabled`      | `boolean`                                  | Defaults to `true`. Registers only while true. |
| `execute`      | `(args) => Result \| Promise<Result>`      | Required.                                      |
| `formatOutput` | `(result, args) => unknown`                | Shapes the result before normalization.        |
| `onError`      | `(error) => void`                          | Fires when `execute` fails.                    |

Read back `tool.supported` (whether this document exposes WebMCP at all), `tool.registered`, and
`tool.error` (a registration failure, such as a `NotAllowedError` from a `tools` permissions policy).

### Reactive options

Pass a plain object when the tool is static. Pass a getter, or a reactive object such as `$state` or
`$props`, when something about it is computed from state. All three work, because every option is
read inside the class's effect.

```js
// static
new WebMCPTool({ name: 'add_todo', description: '…', execute });

// computed from state
new WebMCPTool(() => ({
	name: 'add_todo',
	description: '…',
	enabled: agentCanEdit,
	execute
}));
```

Only what an agent can actually discover triggers a re-registration. Swapping `execute` does not,
and it is resolved fresh on every call, so a closure over `$state` is always current. A getter that
rebuilds a content-equal `inputSchema` or `annotations` does not churn the registration either.

### Result normalization

Whatever `execute` returns becomes a valid MCP response.

| `execute` returns             | Response                                             |
| ----------------------------- | ---------------------------------------------------- |
| a string                      | `{ content: [{ type: 'text', text }] }`              |
| `undefined` or `null`         | `{ content: [] }`, a successful empty result         |
| an object with `content: []`  | passed through untouched                             |
| anything else                 | JSON-serialized into a text block                    |
| a thrown value, or an `Error` | `{ content: [...], isError: true }`, after `onError` |

A failure never reads as success to the agent. That holds for thrown non-Errors (`throw 'not signed in'`),
returned `Error`s, rejected promises, and values that cannot be serialized.

## Browser support

No browser ships WebMCP unflagged. `WebMCPTool` feature-detects and degrades to a no-op, reporting
`supported: false`, so it is safe to render anywhere.

To try it, run Chrome with the feature switched on:

```sh
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --enable-features=WebMCP
```

or enable `chrome://flags/#enable-webmcp-testing`. The API needs a secure context, which includes
`localhost`. Only `document.modelContext` is read. `navigator.modelContext` is a deprecated alias
and is deliberately not checked.

Because `document.modelContext` is often injected by an extension content script after the page has
rendered, the class re-checks every 500ms for 10 seconds before settling on `supported: false`.

## Caveats

**Registration errors are reported synchronously.** Chrome's `registerTool` returns a promise that
rejects on a duplicate name, an empty description, an aborted signal, or a permissions-policy denial.
Like the React hook this ports, `WebMCPTool` decides `registered` from the synchronous path, so those
rejections are not surfaced in `tool.error`.

**Do not let a tool disable itself.** If an `execute` flips its own `enabled` to false, the effect
tears the registration down while the call is still in flight and Chrome drops the response with an
`UnknownError`. The work still lands, but the agent sees a failure. Gate `enabled` on something
orthogonal to what the tool does.

## Development

```sh
npm run dev       # the demo todo app at /
npm run test      # unit tests, then e2e
npm run check     # svelte-check
```

Unit tests run in headless Chromium against a controllable fake, which is what makes registration
call counts, injected failures, and the late-injection probe assertable. The Playwright suite is a
contract test against the real `document.modelContext`, kept small on purpose. It runs the same build
twice, once with `--enable-features=WebMCP` and once without it to check the no-op path.

## Credits

Ported from [`use-webmcp-tool`](https://github.com/GoogleChromeLabs/use-webmcp-tool) by Google LLC,
licensed under Apache 2.0. The result normalization behaviour and the test suite follow that package
closely. See [`NOTICE`](./NOTICE).
