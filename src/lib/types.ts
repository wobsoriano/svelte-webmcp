/**
 * Public types, modelled on `use-webmcp-tool`'s so the two ports stay
 * recognisably the same library.
 *
 * Nothing here declares `document.modelContext` globally. `WebMCPTool` only
 * ever *writes* to `registerTool`, so the parts of the spec still in motion
 * never reach our public API. Consumers who want `getTools()` and
 * `executeTool()` typed should install `@mcp-b/webmcp-types`.
 */

/** A function that reads a value. */
export type Getter<T> = () => T;

/** A value, or a function returning one. */
export type MaybeGetter<T> = T | Getter<T>;

/** A well-formed MCP tool result. */
export type WebMCPToolResponse = {
	content: Array<{ type: string; text?: string; [key: string]: unknown }>;
	isError?: boolean;
};

/**
 * Hints an agent can read before deciding to call a tool.
 *
 * @see https://webmachinelearning.github.io/webmcp/#dictdef-toolannotations
 */
export type ToolAnnotations = {
	readOnlyHint?: boolean;
	untrustedContentHint?: boolean;
};

export type WebMCPToolOptions<Args = Record<string, unknown>, Result = unknown> = {
	/** Tool identifier the agent calls. Changing it re-registers the tool. */
	name: string;

	/** Natural-language description the agent uses to decide when to call it. */
	description: string;

	/** JSON Schema describing `execute`'s argument object. */
	inputSchema?: object;

	annotations?: ToolAnnotations;

	/** Register the tool only while this is true. Defaults to `true`. */
	enabled?: boolean;

	/**
	 * Handles a tool call.
	 *
	 * Resolved fresh on every call rather than captured at registration, so a
	 * closure over `$state` is always current and swapping the function never
	 * re-registers the tool.
	 */
	execute: (args: Args) => Result | Promise<Result>;

	/** Shapes the result before it is normalized into an MCP response. */
	formatOutput?: (result: Result, args: Args) => unknown;

	/** Side effect when `execute` throws, rejects, or returns an `Error`. */
	onError?: (error: unknown) => void;
};

/**
 * What `WebMCPTool` accepts.
 *
 * A plain object is enough for a static tool. Pass a getter, or a reactive
 * object such as `$state` or `$props`, when the tool's identity or its
 * `enabled` flag is computed from state. Either way every field is read inside
 * the class's effect, so reactive reads track and only a change to what an
 * agent actually discovers causes a re-registration.
 */
export type WebMCPToolInput<Args = Record<string, unknown>, Result = unknown> = MaybeGetter<
	WebMCPToolOptions<Args, Result>
>;

/**
 * The slice of `document.modelContext` this library touches.
 *
 * `registerTool` is typed as returning `unknown` on purpose. Chrome returns a
 * promise that rejects on a duplicate name or an empty description, while the
 * fakes used in tests throw synchronously.
 */
export interface ModelContext {
	registerTool(
		tool: {
			name: string;
			description: string;
			inputSchema?: object;
			annotations?: ToolAnnotations;
			execute: (args: Record<string, unknown>) => Promise<WebMCPToolResponse>;
		},
		options?: { signal?: AbortSignal }
	): unknown;
}
