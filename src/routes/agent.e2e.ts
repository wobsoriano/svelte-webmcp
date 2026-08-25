/**
 * Contract test for `WebMCPTool` against the real `document.modelContext`.
 *
 * This suite exists to catch one class of bug that unit tests structurally
 * cannot: the fake in `webmcp-tool.svelte.spec.ts` drifting from what the
 * browser actually does. A fake only encodes what its author already believed,
 * which is how `use-webmcp-tool` ships green tests over registration error
 * handling that is wrong against real Chrome.
 *
 * So keep it small, and keep it about the boundary. Behaviour that is fully
 * observable through a registry belongs in the unit spec, which covers the
 * result and error normalization matrix, registration call counts for the
 * re-registration identity rules, injected registration failures, and the
 * late-injection probe. None of that is repeated here.
 *
 * Verified against Chrome 151: an `isError` result resolves with the same
 * shape as a success, so it needs no separate round trip of its own.
 *
 * Requires the `webmcp` project, which launches Chromium with
 * `--enable-features=WebMCP`.
 */
import { expect, test, type Page } from '@playwright/test';

type RegisteredTool = {
	name: string;
	description: string;
	inputSchema?: string | object;
	annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
};

type ModelContextApi = {
	getTools(): Promise<RegisteredTool[]>;
	executeTool(tool: RegisteredTool, inputArguments: string): Promise<string | null>;
};

/** A tool as the page declared it, with Chrome's wire format undone. */
type ToolRecord = {
	name: string;
	description: string;
	inputSchema: unknown;
	annotations: Record<string, boolean> | null;
};

/**
 * The only place that knows WebMCP's wire format.
 *
 * `getTools()` entries hold a `window` reference, so they cannot cross the
 * evaluate boundary whole. Chrome 149-153 also serialize `inputSchema` to a
 * string, which Chrome 154 returns as an object per webmcp#241.
 */
async function readTools(page: Page): Promise<ToolRecord[]> {
	return page.evaluate(async () => {
		const context = (document as Document & { modelContext: ModelContextApi }).modelContext;
		const tools = await context.getTools();
		return tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema:
				typeof tool.inputSchema === 'string'
					? JSON.parse(tool.inputSchema)
					: (tool.inputSchema ?? null),
			annotations: tool.annotations ? { ...tool.annotations } : null
		}));
	});
}

/** Calls a tool the way an agent does, and returns the decoded MCP result. */
async function callTool(page: Page, name: string, args: Record<string, unknown> = {}) {
	return page.evaluate(
		async ({ name, args }) => {
			const context = (document as Document & { modelContext: ModelContextApi }).modelContext;
			const tools = await context.getTools();
			const tool = tools.find((candidate) => candidate.name === name);
			if (!tool) throw new Error(`Tool "${name}" is not registered`);
			// Chrome takes the tool object plus a JSON string, and answers in kind.
			const raw = await context.executeTool(tool, JSON.stringify(args));
			return typeof raw === 'string' ? JSON.parse(raw) : raw;
		},
		{ name, args }
	);
}

async function toolNames(page: Page): Promise<string[]> {
	return (await readTools(page)).map((tool) => tool.name);
}

/**
 * `page.goto` resolves on load, but the rune only registers once SvelteKit has
 * hydrated and its effect has run. Poll the registry rather than guess.
 */
async function waitForToolCount(page: Page, count: number) {
	await expect.poll(async () => (await toolNames(page)).length).toBe(count);
}

test.beforeEach(async ({ page }) => {
	await page.goto('/');

	// Precondition, not an assertion about the rune. Fails loudly and early if
	// the project is running without the flag, rather than letting every test
	// below fail as "expected 5 tools, got 0".
	const kind = await page.evaluate(
		() => typeof (document as Document & { modelContext?: unknown }).modelContext
	);
	expect(kind, 'this project must run with --enable-features=WebMCP').toBe('object');

	await waitForToolCount(page, 5);
});

test('registers exactly the tools the page declares', async ({ page }) => {
	expect((await toolNames(page)).sort()).toEqual([
		'add_todo',
		'clear_completed',
		'delete_todo',
		'list_todos',
		'toggle_todo'
	]);
	await expect(page.getByTestId('registered-count')).toHaveText('5/5');
});

test('forwards description, inputSchema and annotations to the browser', async ({ page }) => {
	const tools = await readTools(page);
	const add = tools.find((tool) => tool.name === 'add_todo')!;
	const list = tools.find((tool) => tool.name === 'list_todos')!;

	expect(add.description).toBe("Add a new item to the user's todo list.");
	expect(add.inputSchema).toMatchObject({
		type: 'object',
		properties: { text: { type: 'string' } },
		required: ['text']
	});

	// Declared on list_todos only, so this also shows the rune does not invent
	// annotations for tools that did not ask for them.
	expect(list.annotations).toMatchObject({ readOnlyHint: true });
	expect(add.annotations).toBeNull();
});

test('completes a tool call round trip', async ({ page }) => {
	// Chrome hands `execute` the decoded arguments, the rune's response survives
	// serialization back out, and the call reaches the page's own state.
	const result = await callTool(page, 'add_todo', { text: 'Written by an agent' });

	expect(result.isError).toBeFalsy();
	expect(result.content).toEqual([
		{ type: 'text', text: expect.stringContaining('Written by an agent') }
	]);
	await expect(page.getByTestId('todo-list').getByText('Written by an agent')).toBeVisible();
});

test('unregisters and re-registers as enabled changes', async ({ page }) => {
	expect(await toolNames(page)).toContain('add_todo');

	await page.getByTestId('agent-edit').uncheck();

	await waitForToolCount(page, 1);
	expect(await toolNames(page)).toEqual(['list_todos']);
	await expect(page.getByTestId('registered-count')).toHaveText('1/5');

	await page.getByTestId('agent-edit').check();

	await waitForToolCount(page, 5);
	expect(await toolNames(page)).toContain('add_todo');
});
