import type {
	Getter,
	ModelContext,
	WebMCPToolInput,
	WebMCPToolOptions,
	WebMCPToolResponse
} from './types.js';

/**
 * `document.modelContext` is typically injected by a browser extension whose
 * content script may run after the page has already rendered. Rather than
 * reporting `supported: false` forever, probe briefly and give up.
 */
const PROBE_INTERVAL_MS = 500;
const PROBE_ATTEMPTS = 20;

/** Stringify for error reporting without ever throwing itself. */
function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * Normalizes whatever `execute` returns into an MCP tool result, so callers can
 * return a plain string or object and still hand the agent a valid response.
 */
function toToolResponse(value: unknown): WebMCPToolResponse {
	if (value && typeof value === 'object' && Array.isArray((value as WebMCPToolResponse).content)) {
		return value as WebMCPToolResponse;
	}

	if (value === undefined || value === null) {
		return { content: [] };
	}

	if (typeof value === 'string') {
		return { content: [{ type: 'text', text: value }] };
	}

	// A circular structure throws here, and is caught as an error result.
	return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/**
 * Every failure becomes an explicit `isError` result, whatever was thrown. A
 * thrown string or plain object must not read as success to the agent.
 */
function toErrorResponse(error: unknown): WebMCPToolResponse {
	const text =
		error instanceof Error
			? error.message
			: typeof error === 'string'
				? error
				: safeStringify(error);
	return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Resolves the WebMCP entry point for this document.
 *
 * `document.modelContext` only. `navigator.modelContext` is a deprecated alias
 * and is deliberately not checked, matching the React hook this ports.
 */
export function getModelContext(): ModelContext | null {
	if (typeof document === 'undefined') return null;
	return (document as Document & { modelContext?: ModelContext }).modelContext ?? null;
}

/**
 * Registers a WebMCP tool and ties its lifetime to the surrounding effect.
 *
 * The tool is registered when the owning component mounts and unregistered
 * when it is destroyed, so the set of tools an agent discovers stays in
 * lockstep with what is actually on screen.
 *
 * ```svelte
 * <script>
 *   import { WebMCPTool } from 'svelte-webmcp';
 *
 *   let todos = $state([]);
 *
 *   const tool = new WebMCPTool({
 *     name: 'add_todo',
 *     description: "Add an item to the user's todo list",
 *     inputSchema: {
 *       type: 'object',
 *       properties: { text: { type: 'string' } },
 *       required: ['text']
 *     },
 *     execute({ text }) {
 *       todos.push({ text, done: false });
 *       return `Added "${text}"`;
 *     }
 *   });
 * </script>
 *
 * {#if tool.supported}
 *   <p>{tool.registered ? 'Agent tools ready' : '...'}</p>
 * {/if}
 * ```
 *
 * Must be constructed during component initialisation, or inside an
 * `$effect.root`, because it creates an effect.
 */
export class WebMCPTool<Args = Record<string, unknown>, Result = unknown> {
	#supported = $state(false);
	#registered = $state(false);
	#error = $state<Error | null>(null);

	// Overloaded rather than taking the bare union: a union of an object and a
	// function defeats contextual typing, forcing callers to annotate `execute`.
	constructor(options: WebMCPToolOptions<Args, Result>);
	constructor(options: Getter<WebMCPToolOptions<Args, Result>>);
	constructor(input: WebMCPToolInput<Args, Result>) {
		// Resolved rather than destructured, so a getter and a reactive object
		// both work, and so `execute` is read fresh at call time.
		const resolve = (): WebMCPToolOptions<Args, Result> =>
			typeof input === 'function' ? input() : input;

		const options = $derived(resolve());

		// Only what an agent discovers should trigger a re-registration, so the
		// schema and annotations are compared by serialized content. Key-order
		// sensitive: `{a, b}` and `{b, a}` count as different.
		const name = $derived(options.name);
		const description = $derived(options.description);
		const schemaKey = $derived(options.inputSchema ? JSON.stringify(options.inputSchema) : '');
		const annotationsKey = $derived(options.annotations ? JSON.stringify(options.annotations) : '');
		const enabled = $derived(options.enabled ?? true);

		// Set when a late-injected API is found, which re-runs registration.
		let lateContext = $state<ModelContext | null>(null);

		$effect(() => {
			// Read up front, because the early returns below would otherwise
			// vary the effect's dependency set between runs.
			const descriptor = {
				name,
				description,
				inputSchema: schemaKey ? JSON.parse(schemaKey) : undefined,
				annotations: annotationsKey ? JSON.parse(annotationsKey) : undefined
			};
			const isEnabled = enabled;

			const context = lateContext ?? getModelContext();

			if (!context) {
				this.#set(false, false, null);

				let attempts = 0;
				const timer = setInterval(() => {
					const found = getModelContext();
					if (found) {
						clearInterval(timer);
						lateContext = found;
					} else if (++attempts >= PROBE_ATTEMPTS) {
						clearInterval(timer);
					}
				}, PROBE_INTERVAL_MS);
				return () => clearInterval(timer);
			}

			if (!isEnabled) {
				this.#set(true, false, null);
				return;
			}

			const controller = new AbortController();

			try {
				const registration = context.registerTool(
					{
						...descriptor,
						execute: async (args) => {
							// Resolved per call, so the latest `execute` runs even
							// though a changed closure never re-registers.
							const current = resolve();
							try {
								const result = await current.execute(args as Args);
								const shaped = current.formatOutput
									? current.formatOutput(result, args as Args)
									: result;
								// A returned Error is treated exactly like a thrown one.
								if (shaped instanceof Error) throw shaped;
								return toToolResponse(shaped);
							} catch (error) {
								current.onError?.(error);
								return toErrorResponse(error);
							}
						}
					},
					{ signal: controller.signal }
				);

				// Chrome resolves registration asynchronously. Swallow a rejection
				// so it is not reported as unhandled, but decide `registered`
				// synchronously, as the React hook this ports does.
				Promise.resolve(registration).catch(() => {});

				this.#set(true, true, null);
			} catch (error) {
				this.#set(true, false, error instanceof Error ? error : new Error(safeStringify(error)));
			}

			// Aborting is how WebMCP unregisters, so this runs on destroy and
			// before every re-registration.
			return () => controller.abort();
		});
	}

	#set(supported: boolean, registered: boolean, error: Error | null) {
		this.#supported = supported;
		this.#registered = registered;
		this.#error = error;
	}

	get supported(): boolean {
		return this.#supported;
	}

	get registered(): boolean {
		return this.#registered;
	}

	get error(): Error | null {
		return this.#error;
	}
}
