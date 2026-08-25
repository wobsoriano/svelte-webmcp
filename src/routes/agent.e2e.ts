/**
 * Contract test for `WebMCPTool` against the real `document.modelContext`.
 *
 * Its job is to catch the unit spec's fake drifting from the browser, so it
 * stays small and covers only the boundary. Anything observable through a
 * registry (result and error normalization, registration call counts, injected
 * failures, the late-injection probe) belongs in `webmcp-tool.svelte.spec.ts`.
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

/**
 * The only place that knows WebMCP's wire format. Entries hold a `window`
 * reference so they cannot cross the evaluate boundary whole, and Chrome
 * 149-153 serialize `inputSchema` to a string that 154 returns as an object.
 */
async function readTools(page: Page) {
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

/** `page.goto` resolves on load, but the rune registers only once hydrated. */
async function waitForToolCount(page: Page, count: number) {
	await expect.poll(async () => (await toolNames(page)).length).toBe(count);
}

test.beforeEach(async ({ page }) => {
	await page.goto('/');

	// A precondition, so a missing flag fails here rather than as five
	// confusing "expected 5 tools, got 0".
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

	// Declared on list_todos only, so this also shows the rune invents nothing.
	expect(list.annotations).toMatchObject({ readOnlyHint: true });
	expect(add.annotations).toBeNull();
});

test('completes a tool call round trip', async ({ page }) => {
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
