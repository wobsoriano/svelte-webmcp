import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { WebMCPTool } from './webmcp-tool.svelte.js';
import type { ModelContext, WebMCPToolOptions, WebMCPToolResponse } from './types.js';

/**
 * Unit coverage of `WebMCPTool`. The fake below stands in for the browser, so
 * every assertion is about what the rune does with it: what it registers, when
 * it re-registers, and how it normalizes what `execute` returns.
 *
 * Ported from `useWebMCP.test.jsx` in GoogleChromeLabs/use-webmcp-tool, with
 * two deliberate departures. React's StrictMode test has no Svelte analogue
 * (nothing double-mounts), so its slot covers the equivalent Svelte failure
 * instead, an over-eager effect re-run leaving an orphaned registration. And
 * `renderHook` becomes an `$effect.root` harness, where "rerender with new
 * props" is a mutation of a reactive options object.
 */

type FakeTool = {
	name: string;
	description: string;
	inputSchema?: object;
	annotations?: object;
	execute: (args: Record<string, unknown>) => Promise<WebMCPToolResponse>;
};

/**
 * Minimal fake of the provider side of `document.modelContext`: registerTool
 * plus AbortSignal unregistration, mirroring both the explainer and the
 * behaviour verified against Chrome 151 under `--enable-features=WebMCP`.
 */
function installFakeModelContext() {
	const tools = new Map<string, FakeTool>();
	const registerTool = vi.fn((tool: FakeTool, options: { signal?: AbortSignal } = {}) => {
		tools.set(tool.name, tool);
		options.signal?.addEventListener('abort', () => {
			if (tools.get(tool.name) === tool) tools.delete(tool.name);
		});
	});
	setModelContext({ registerTool } as unknown as ModelContext);
	return { tools, registerTool };
}

function setModelContext(context: ModelContext) {
	(document as Document & { modelContext?: ModelContext }).modelContext = context;
}

const baseOptions = {
	name: 'add-todo',
	description: 'Add a todo',
	inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
} satisfies Omit<WebMCPToolOptions, 'execute'>;

/** Everything the harness has mounted, torn down after each test. */
const roots: Array<() => void> = [];

/**
 * Stands in for React's `renderHook`. The options object is reactive, so
 * `rerender` is a plain mutation and the class picks it up exactly as it would
 * from a component's `$state` or `$props`.
 */
function renderTool(overrides: Partial<WebMCPToolOptions> = {}) {
	const props = $state<WebMCPToolOptions>({
		...baseOptions,
		execute: () => 'ok',
		...overrides
	});

	let tool!: WebMCPTool;
	const stop = $effect.root(() => {
		tool = new WebMCPTool(props);
	});
	roots.push(stop);
	flushSync();

	return {
		get tool() {
			return tool;
		},
		props,
		rerender(next: Partial<WebMCPToolOptions>) {
			Object.assign(props, next);
			flushSync();
		},
		unmount() {
			stop();
		}
	};
}

/** The rune's readable state, for whole-object comparison. */
function state(tool: WebMCPTool) {
	return { supported: tool.supported, registered: tool.registered, error: tool.error };
}

afterEach(() => {
	while (roots.length) roots.pop()!();
	delete (document as Document & { modelContext?: ModelContext }).modelContext;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('registration lifecycle', () => {
	it('registers on mount and unregisters (via abort) on destroy', () => {
		const { tools, registerTool } = installFakeModelContext();
		const harness = renderTool();

		expect(state(harness.tool)).toEqual({ supported: true, registered: true, error: null });
		expect(registerTool).toHaveBeenCalledTimes(1);

		const [tool] = registerTool.mock.calls[0];
		expect(tool.name).toBe('add-todo');
		expect(tool.description).toBe('Add a todo');
		expect(tool.inputSchema).toEqual(baseOptions.inputSchema);

		harness.unmount();
		expect(tools.size).toBe(0);
	});

	it('passes annotations through to registerTool', () => {
		const { registerTool } = installFakeModelContext();
		const annotations = { readOnlyHint: true, untrustedContentHint: false };
		renderTool({ annotations });

		expect(registerTool).toHaveBeenCalledTimes(1);
		const [tool] = registerTool.mock.calls[0];
		expect(tool.annotations).toEqual(annotations);
	});

	it('reports supported: false when document.modelContext is absent', () => {
		const harness = renderTool();
		expect(state(harness.tool)).toEqual({ supported: false, registered: false, error: null });
	});

	it('does not re-register when unrelated reactive state changes', () => {
		// Stands in for React's StrictMode test. Svelte never double-mounts, but
		// an options getter that reads unrelated state re-runs on every change,
		// and must not churn the registration or leak an orphaned tool.
		const { tools, registerTool } = installFakeModelContext();
		let unrelated = $state(0);

		const stop = $effect.root(() => {
			new WebMCPTool(() => ({
				...baseOptions,
				// Recomputed every time `unrelated` changes, but always the same
				// value, so nothing an agent can discover actually changed.
				enabled: unrelated >= 0,
				execute: () => 'ok'
			}));
		});
		roots.push(stop);
		flushSync();

		expect(registerTool).toHaveBeenCalledTimes(1);

		unrelated = 1;
		flushSync();

		expect(registerTool).toHaveBeenCalledTimes(1);
		expect(tools.size).toBe(1);
	});

	it('honors the enabled flag, registering only while true', () => {
		const { tools } = installFakeModelContext();
		const harness = renderTool({ enabled: false });

		expect(state(harness.tool)).toEqual({ supported: true, registered: false, error: null });
		expect(tools.size).toBe(0);

		harness.rerender({ enabled: true });
		expect(harness.tool.registered).toBe(true);
		expect(tools.size).toBe(1);

		harness.rerender({ enabled: false });
		expect(harness.tool.registered).toBe(false);
		expect(tools.size).toBe(0);
	});

	it('detects document.modelContext injected after mount', () => {
		vi.useFakeTimers();
		const harness = renderTool();
		expect(harness.tool.supported).toBe(false);

		installFakeModelContext();
		vi.advanceTimersByTime(500);
		flushSync();

		expect(state(harness.tool)).toEqual({ supported: true, registered: true, error: null });
	});

	it('stops probing for a late-injected API after 10 seconds', () => {
		vi.useFakeTimers();
		const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
		const harness = renderTool();

		vi.advanceTimersByTime(11_000);
		flushSync();

		expect(harness.tool.supported).toBe(false);
		expect(clearIntervalSpy).toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('surfaces a registration error, wrapping non-Error throws', () => {
		setModelContext({
			registerTool: () => {
				throw 'NotAllowedError-ish string';
			}
		} as unknown as ModelContext);

		const harness = renderTool();

		expect(harness.tool.supported).toBe(true);
		expect(harness.tool.registered).toBe(false);
		expect(harness.tool.error).toBeInstanceOf(Error);
		expect(harness.tool.error?.message).toContain('NotAllowedError-ish');
	});
});

describe('re-registration identity', () => {
	it('does not re-register when only the execute closure changes, but calls the latest one', async () => {
		const { tools, registerTool } = installFakeModelContext();
		const harness = renderTool({ execute: () => 'first' });

		harness.rerender({ execute: () => 'second' });
		expect(registerTool).toHaveBeenCalledTimes(1);

		const response = await tools.get('add-todo')!.execute({});
		expect(response).toEqual({ content: [{ type: 'text', text: 'second' }] });
	});

	it('does not re-register for a new inputSchema object with identical content', () => {
		const { registerTool } = installFakeModelContext();
		const schema = () => ({ type: 'object', properties: { text: { type: 'string' } } });
		const harness = renderTool({ inputSchema: schema() });

		harness.rerender({ inputSchema: schema() });
		expect(registerTool).toHaveBeenCalledTimes(1);
	});

	it('does not re-register for a new annotations object with identical content', () => {
		const { registerTool } = installFakeModelContext();
		const annots = () => ({ readOnlyHint: true });
		const harness = renderTool({ annotations: annots() });

		harness.rerender({ annotations: annots() });
		expect(registerTool).toHaveBeenCalledTimes(1);
	});

	it('re-registers when annotations change', () => {
		const { registerTool } = installFakeModelContext();
		const harness = renderTool({ annotations: { readOnlyHint: true } });

		harness.rerender({ annotations: { readOnlyHint: false } });
		expect(registerTool).toHaveBeenCalledTimes(2);
	});

	it("re-registers when the tool's discoverable identity changes", () => {
		const { tools, registerTool } = installFakeModelContext();
		const harness = renderTool();

		harness.rerender({ name: 'add-item' });
		expect(registerTool).toHaveBeenCalledTimes(2);
		expect(tools.has('add-todo')).toBe(false);
		expect(tools.has('add-item')).toBe(true);
	});
});

describe('result normalization', () => {
	async function executeWith(
		overrides: Partial<WebMCPToolOptions>,
		args: Record<string, unknown> = {}
	) {
		const { tools } = installFakeModelContext();
		renderTool(overrides);
		return tools.get('add-todo')!.execute(args);
	}

	it('wraps a returned string in a text content block', async () => {
		const response = await executeWith({ execute: () => 'Added!' });
		expect(response).toEqual({ content: [{ type: 'text', text: 'Added!' }] });
	});

	it('treats undefined/null returns as an empty successful result', async () => {
		expect(await executeWith({ execute: () => {} })).toEqual({ content: [] });
		expect(await executeWith({ execute: () => null })).toEqual({ content: [] });
	});

	it('passes through an already well-formed MCP result untouched', async () => {
		const canonical = { content: [{ type: 'text', text: 'hi' }], isError: false };
		const response = await executeWith({ execute: () => canonical });
		expect(response).toBe(canonical);
	});

	it('JSON-serializes objects and numbers into a text block', async () => {
		expect(await executeWith({ execute: () => ({ id: 7 }) })).toEqual({
			content: [{ type: 'text', text: '{"id":7}' }]
		});
		expect(await executeWith({ execute: () => 42 })).toEqual({
			content: [{ type: 'text', text: '42' }]
		});
	});

	it('applies formatOutput before normalization', async () => {
		const response = await executeWith(
			{
				execute: () => ({ id: 7 }),
				formatOutput: (result, args) =>
					`#${(result as { id: number }).id} for ${(args as { who: string }).who}`
			},
			{ who: 'sarah' }
		);
		expect(response).toEqual({ content: [{ type: 'text', text: '#7 for sarah' }] });
	});
});

describe('error normalization', () => {
	async function executeWith(
		overrides: Partial<WebMCPToolOptions>,
		args: Record<string, unknown> = {}
	) {
		const { tools } = installFakeModelContext();
		renderTool(overrides);
		return tools.get('add-todo')!.execute(args);
	}

	it('turns a thrown Error into an isError result and calls onError', async () => {
		const onError = vi.fn();
		const boom = new Error('nope');
		const response = await executeWith({
			execute: () => {
				throw boom;
			},
			onError
		});
		expect(response).toEqual({ content: [{ type: 'text', text: 'nope' }], isError: true });
		expect(onError).toHaveBeenCalledWith(boom);
	});

	it('marks a thrown non-Error string as isError, not success', async () => {
		const response = await executeWith({
			execute: () => {
				throw 'not signed in';
			}
		});
		expect(response).toEqual({
			content: [{ type: 'text', text: 'not signed in' }],
			isError: true
		});
	});

	it('marks a thrown plain object as isError with its JSON as text', async () => {
		const response = await executeWith({
			execute: () => {
				throw { code: 403 };
			}
		});
		expect(response).toEqual({
			content: [{ type: 'text', text: '{"code":403}' }],
			isError: true
		});
	});

	it('treats a returned Error like a thrown one: isError and onError', async () => {
		const onError = vi.fn();
		const boom = new Error('returned, not thrown');
		const response = await executeWith({ execute: () => boom, onError });
		expect(response).toEqual({
			content: [{ type: 'text', text: 'returned, not thrown' }],
			isError: true
		});
		expect(onError).toHaveBeenCalledWith(boom);
	});

	it('turns a rejected async execute into an isError result', async () => {
		const response = await executeWith({
			execute: async () => Promise.reject(new Error('async nope'))
		});
		expect(response).toEqual({
			content: [{ type: 'text', text: 'async nope' }],
			isError: true
		});
	});

	it('reports an unserializable (circular) return as an error, not a crash', async () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const response = await executeWith({ execute: () => circular });
		expect(response.isError).toBe(true);
		expect(response.content[0].text).toMatch(/circular/i);
	});
});
