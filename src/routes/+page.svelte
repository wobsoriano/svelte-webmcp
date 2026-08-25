<script lang="ts">
	import { WebMCPTool } from '#lib';
	import { MediaQuery } from 'svelte/reactivity';
	import { fly } from 'svelte/transition';

	type Todo = { id: number; text: string; done: boolean };
	type Call = { name: string; text: string; isError?: boolean };

	let todos = $state<Todo[]>([
		{ id: 1, text: 'Buy milk', done: false },
		{ id: 2, text: 'Ship svelte-webmcp', done: false },
		{ id: 3, text: 'Read the WebMCP spec', done: true }
	]);
	let draft = $state('');
	let lastCall = $state<Call | null>(null);
	let nextId = 4;

	/**
	 * Revokes the agent's write access while leaving the page fully usable by
	 * hand. Every write tool reads this through getter options, so switching it
	 * off unregisters them and they vanish from what an agent can discover.
	 */
	let agentCanEdit = $state(true);

	const activeCount = $derived(todos.filter((todo) => !todo.done).length);
	const hasCompleted = $derived(todos.some((todo) => todo.done));

	const motionOk = new MediaQuery('(prefers-reduced-motion: no-preference)');
	const motion = $derived(motionOk.current ? { y: 6, duration: 160 } : { y: 0, duration: 0 });

	/** Records what an agent just did, so the call is visible on screen. */
	function record(name: string, text: string): string {
		lastCall = { name, text };
		return text;
	}

	function addTodo(text: string): Todo {
		const todo = { id: nextId++, text, done: false };
		todos.push(todo);
		return todo;
	}

	function submitDraft(event: SubmitEvent) {
		event.preventDefault();
		const text = draft.trim();
		if (!text) return;
		addTodo(text);
		draft = '';
	}

	// Getter options, because `enabled` is computed from state. Everything that
	// writes is gated the same way.
	const addTool = new WebMCPTool<{ text: string }>(() => ({
		name: 'add_todo',
		description: "Add a new item to the user's todo list.",
		enabled: agentCanEdit,
		inputSchema: {
			type: 'object',
			properties: { text: { type: 'string', description: 'What the item says' } },
			required: ['text']
		},
		execute({ text }) {
			const todo = addTodo(text);
			return record('add_todo', `Added #${todo.id} "${todo.text}"`);
		}
	}));

	// Plain object options, because nothing about this tool changes. It reads
	// rather than writes, so it survives edits being switched off.
	const listTool = new WebMCPTool<{ filter?: 'all' | 'active' | 'completed' }, Todo[]>({
		name: 'list_todos',
		description: 'List the todo items, optionally filtered by completion state.',
		annotations: { readOnlyHint: true },
		inputSchema: {
			type: 'object',
			properties: { filter: { type: 'string', enum: ['all', 'active', 'completed'] } }
		},
		execute({ filter = 'all' }) {
			if (filter === 'active') return todos.filter((todo) => !todo.done);
			if (filter === 'completed') return todos.filter((todo) => todo.done);
			return todos;
		},
		formatOutput(result) {
			const text = result.length
				? result.map((todo) => `${todo.done ? '[x]' : '[ ]'} #${todo.id} ${todo.text}`).join('\n')
				: 'No matching todos.';
			return record('list_todos', text);
		}
	});

	// Throwing is how a tool reports failure. `onError` is the side effect.
	const toggleTool = new WebMCPTool<{ id: number }>(() => ({
		name: 'toggle_todo',
		description: 'Toggle a todo item between active and completed, by id.',
		enabled: agentCanEdit,
		inputSchema: {
			type: 'object',
			properties: { id: { type: 'number', description: 'The item id' } },
			required: ['id']
		},
		execute({ id }) {
			const todo = todos.find((candidate) => candidate.id === id);
			if (!todo) throw new Error(`No todo with id ${id}`);
			todo.done = !todo.done;
			return record('toggle_todo', `${todo.done ? 'Completed' : 'Reopened'} "${todo.text}"`);
		},
		onError(error) {
			lastCall = {
				name: 'toggle_todo',
				text: error instanceof Error ? error.message : String(error),
				isError: true
			};
		}
	}));

	const deleteTool = new WebMCPTool<{ id: number }>(() => ({
		name: 'delete_todo',
		description: 'Permanently remove a todo item by id.',
		enabled: agentCanEdit,
		inputSchema: {
			type: 'object',
			properties: { id: { type: 'number', description: 'The item id' } },
			required: ['id']
		},
		execute({ id }) {
			const index = todos.findIndex((candidate) => candidate.id === id);
			if (index === -1) throw new Error(`No todo with id ${id}`);
			const [removed] = todos.splice(index, 1);
			return record('delete_todo', `Deleted #${removed.id} "${removed.text}"`);
		}
	}));

	// Deliberately not gated on `hasCompleted`. A tool that flips its own
	// `enabled` to false is torn down while its call is still in flight, and
	// Chrome drops the response even though the work landed. Clearing nothing
	// is a safe no-op, so this stays registered and reports what it did.
	const clearTool = new WebMCPTool(() => ({
		name: 'clear_completed',
		description: 'Remove every completed todo item.',
		enabled: agentCanEdit,
		execute() {
			const cleared = todos.filter((todo) => todo.done).length;
			todos = todos.filter((todo) => !todo.done);
			return record('clear_completed', `Cleared ${cleared} completed item(s)`);
		}
	}));

	const manifest = $derived([
		{ tool: addTool, name: 'add_todo', signature: 'text: string' },
		{ tool: listTool, name: 'list_todos', signature: 'filter?: string' },
		{ tool: toggleTool, name: 'toggle_todo', signature: 'id: number' },
		{ tool: deleteTool, name: 'delete_todo', signature: 'id: number' },
		{ tool: clearTool, name: 'clear_completed', signature: '()' }
	]);

	const registered = $derived(manifest.filter((entry) => entry.tool.registered));
	const supported = $derived(listTool.supported);
</script>

<svelte:head>
	<title>Todos · svelte-webmcp</title>
</svelte:head>

<div class="page">
	<header class="bar">
		<span class="wordmark">svelte-webmcp</span>
		<span class="status" class:on={supported} data-testid="support-status">
			<i class="dot" aria-hidden="true"></i>
			{supported ? 'WebMCP available' : 'WebMCP unavailable'}
		</span>
	</header>

	<div class="intro">
		<h1>Todos</h1>
		<p class="lede">
			Five tools, registered only while this page is open. An agent can run the whole list without
			touching the DOM.
		</p>
		{#if !supported}
			<p class="hint">
				This browser does not expose <code>document.modelContext</code>. Start Chrome with
				<code>--enable-features=WebMCP</code> to let an agent drive the page. Everything below still works
				by hand.
			</p>
		{/if}
	</div>

	<div class="columns">
		<section class="panel list" aria-label="Todo list">
			<form onsubmit={submitDraft}>
				<input
					bind:value={draft}
					placeholder="Add a todo"
					aria-label="Add a todo"
					autocomplete="off"
				/>
				<button type="submit" disabled={!draft.trim()}>Add</button>
			</form>

			<ul data-testid="todo-list">
				{#each todos as todo (todo.id)}
					<li transition:fly={motion}>
						<label>
							<input
								type="checkbox"
								checked={todo.done}
								onchange={() => (todo.done = !todo.done)}
							/>
							<span class="text" class:done={todo.done}>{todo.text}</span>
						</label>
						<span class="id">#{todo.id}</span>
						<button
							class="remove"
							aria-label="Delete {todo.text}"
							onclick={() => (todos = todos.filter((candidate) => candidate.id !== todo.id))}
						>
							&times;
						</button>
					</li>
				{:else}
					<li class="empty">Nothing here yet. Add the first item above.</li>
				{/each}
			</ul>

			<footer>
				<span data-testid="active-count">{activeCount} active</span>
				<button
					class="clear"
					disabled={!hasCompleted}
					onclick={() => (todos = todos.filter((todo) => !todo.done))}
				>
					Clear completed
				</button>
			</footer>
		</section>

		<aside class="panel readout" aria-label="Tool manifest">
			<div class="readout-head">
				<span class="micro">Tool manifest</span>
				<span class="count" data-testid="registered-count">{registered.length}/5</span>
			</div>
			<p class="readout-sub">What an agent can see right now.</p>

			<label class="switch">
				<input type="checkbox" role="switch" bind:checked={agentCanEdit} data-testid="agent-edit" />
				<span>Agent can edit</span>
			</label>

			<ul class="tools" data-testid="tool-manifest">
				{#each registered as entry (entry.name)}
					<li transition:fly={motion} data-tool={entry.name}>
						<i class="dot on" aria-hidden="true"></i>
						<span class="tool-name">{entry.name}</span>
						<span class="sig">{entry.signature}</span>
					</li>
				{/each}
			</ul>

			<div class="readout-head divider">
				<span class="micro">Last agent call</span>
			</div>
			{#if lastCall}
				<div class="call" class:error={lastCall.isError} data-testid="last-call">
					<span class="tool-name">{lastCall.name}</span>
					<pre>{lastCall.text}</pre>
				</div>
			{:else}
				<p class="none" data-testid="last-call-empty">No calls yet.</p>
			{/if}
		</aside>
	</div>
</div>

<style>
	:global(html) {
		--paper: #f2f3f6;
		--surface: #ffffff;
		--recess: #eceef3;
		--ink: #14161d;
		--muted: #6b7080;
		--line: #dfe1e8;
		--signal: #2b4bff;
		--danger: #c02a34;
		color-scheme: light dark;
	}

	@media (prefers-color-scheme: dark) {
		:global(html) {
			--paper: #0e1015;
			--surface: #161922;
			--recess: #12141b;
			--ink: #e8e9ed;
			--muted: #878c9b;
			--line: #262a35;
			--signal: #7d93ff;
			--danger: #ff8f8f;
		}
	}

	:global(body) {
		margin: 0;
		background: var(--paper);
		color: var(--ink);
		font-family:
			ui-sans-serif,
			system-ui,
			-apple-system,
			'Segoe UI',
			sans-serif;
		-webkit-font-smoothing: antialiased;
	}

	.page {
		max-width: 62rem;
		margin: 0 auto;
		padding: 2rem 1.5rem 5rem;
	}

	.micro,
	.wordmark,
	.status,
	.sig,
	.tool-name,
	.id,
	.count {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	}

	.bar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding-bottom: 1.5rem;
		border-bottom: 1px solid var(--line);
	}

	.wordmark {
		font-size: 0.8125rem;
		letter-spacing: -0.01em;
	}

	.status {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.6875rem;
		text-transform: uppercase;
		letter-spacing: 0.14em;
		color: var(--muted);
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--muted);
		flex: none;
	}

	.status.on .dot,
	.dot.on {
		background: var(--signal);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--signal) 18%, transparent);
	}

	.intro {
		padding: 3rem 0 2.5rem;
		max-width: 34rem;
	}

	h1 {
		margin: 0;
		font-size: clamp(2.5rem, 7vw, 3.5rem);
		font-weight: 800;
		letter-spacing: -0.035em;
		line-height: 1;
	}

	.lede {
		margin: 1rem 0 0;
		font-size: 1.0625rem;
		line-height: 1.55;
		color: var(--muted);
	}

	.hint {
		margin: 1.25rem 0 0;
		padding: 0.875rem 1rem;
		border-left: 2px solid var(--signal);
		background: var(--recess);
		font-size: 0.875rem;
		line-height: 1.6;
		color: var(--muted);
	}

	.hint code {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.8125em;
		color: var(--ink);
	}

	.columns {
		display: grid;
		grid-template-columns: 1.35fr 1fr;
		gap: 1.25rem;
		align-items: stretch;
	}

	@media (max-width: 48rem) {
		.columns {
			grid-template-columns: 1fr;
		}
	}

	.panel {
		border: 1px solid var(--line);
		border-radius: 10px;
	}

	.list {
		display: flex;
		flex-direction: column;
		background: var(--surface);
		padding: 1.25rem;
	}

	.list ul {
		flex: 1;
	}

	form {
		display: flex;
		gap: 0.5rem;
	}

	form input {
		flex: 1;
		min-width: 0;
		padding: 0.625rem 0.75rem;
		border: 1px solid var(--line);
		border-radius: 7px;
		background: var(--paper);
		color: inherit;
		font: inherit;
		font-size: 0.9375rem;
	}

	form input:focus-visible,
	button:focus-visible {
		outline: 2px solid var(--signal);
		outline-offset: 1px;
	}

	button {
		font: inherit;
		cursor: pointer;
		border-radius: 7px;
		border: 1px solid transparent;
		background: var(--signal);
		color: #fff;
		padding: 0.625rem 1rem;
		font-size: 0.875rem;
		font-weight: 600;
	}

	button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	ul {
		list-style: none;
		margin: 1.25rem 0 0;
		padding: 0;
	}

	.list li {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.6875rem 0;
		border-bottom: 1px solid var(--line);
	}

	.list li.empty {
		display: block;
		color: var(--muted);
		font-size: 0.9375rem;
		padding: 1.5rem 0;
		text-align: center;
	}

	label {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex: 1;
		min-width: 0;
		cursor: pointer;
	}

	input[type='checkbox'] {
		accent-color: var(--signal);
		width: 1rem;
		height: 1rem;
		flex: none;
	}

	.text {
		font-size: 0.9375rem;
	}

	.text.done {
		color: var(--muted);
		text-decoration: line-through;
	}

	.id {
		font-size: 0.75rem;
		color: var(--muted);
	}

	.remove {
		background: none;
		color: var(--muted);
		border: none;
		padding: 0.125rem 0.375rem;
		font-size: 1.125rem;
		line-height: 1;
	}

	.remove:hover {
		color: var(--danger);
	}

	.list footer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding-top: 1rem;
		font-size: 0.8125rem;
		color: var(--muted);
	}

	.clear {
		background: none;
		border: 1px solid var(--line);
		color: var(--muted);
		padding: 0.375rem 0.75rem;
		font-size: 0.8125rem;
		font-weight: 500;
	}

	.clear:not(:disabled):hover {
		color: var(--ink);
		border-color: var(--muted);
	}

	.readout {
		background: var(--recess);
		padding: 1.125rem 1.25rem 1.25rem;
	}

	.readout-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
	}

	.readout-head.divider {
		margin-top: 1.75rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--line);
	}

	.micro {
		font-size: 0.6875rem;
		text-transform: uppercase;
		letter-spacing: 0.14em;
		color: var(--muted);
	}

	.count {
		font-size: 0.75rem;
		color: var(--signal);
	}

	.readout-sub {
		margin: 0.5rem 0 0;
		font-size: 0.8125rem;
		color: var(--muted);
	}

	.tools {
		margin-top: 0.875rem;
	}

	.tools li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4375rem 0;
	}

	.tool-name {
		font-size: 0.8125rem;
		color: var(--ink);
	}

	.sig {
		font-size: 0.6875rem;
		color: var(--muted);
		margin-left: auto;
	}

	.call {
		margin-top: 0.875rem;
		padding: 0.75rem;
		border-radius: 7px;
		background: var(--surface);
		border: 1px solid var(--line);
	}

	.call.error {
		border-color: color-mix(in srgb, var(--danger) 45%, var(--line));
	}

	.call pre {
		margin: 0.5rem 0 0;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.75rem;
		line-height: 1.6;
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--muted);
	}

	.call.error pre {
		color: var(--danger);
	}

	.switch {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.75rem;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid var(--line);
		cursor: pointer;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.6875rem;
		text-transform: uppercase;
		letter-spacing: 0.14em;
		color: var(--muted);
	}

	.switch:has(:checked) {
		color: var(--ink);
	}

	.switch input {
		accent-color: var(--signal);
		width: 0.875rem;
		height: 0.875rem;
		flex: none;
	}

	.none {
		margin: 0.875rem 0 0;
		font-size: 0.8125rem;
		color: var(--muted);
	}
</style>
