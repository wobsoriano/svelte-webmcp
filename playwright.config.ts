import { defineConfig } from '@playwright/test';

/**
 * Two projects over the same preview build.
 *
 * `webmcp` launches Chromium with the real WebMCP implementation switched on,
 * so the agent-facing tests drive the genuine `document.modelContext` rather
 * than a fake. Playwright's bundled Chromium is recent enough, no branded
 * Chrome channel is needed, and `http://localhost` counts as a secure context.
 *
 * `no-webmcp` is the same build with the flag off, which is the state of
 * essentially every browser today. It exists to prove the page degrades to a
 * working, hand-operated todo list rather than breaking.
 */
export default defineConfig({
	webServer: {
		command: 'npm run build && npm run preview',
		port: 4173,
		reuseExistingServer: !process.env.CI
	},
	testMatch: '**/*.e2e.{ts,js}',
	projects: [
		{
			name: 'webmcp',
			testMatch: /agent\.e2e\.ts$/,
			use: { launchOptions: { args: ['--enable-features=WebMCP'] } }
		},
		{
			name: 'no-webmcp',
			testMatch: /degraded\.e2e\.ts$/
		}
	]
});
