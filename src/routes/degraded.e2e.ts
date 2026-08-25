/**
 * Contract test for `WebMCPTool` in a browser with no WebMCP, which is every
 * browser by default. Runs under the `no-webmcp` project, the same build
 * without `--enable-features=WebMCP`.
 *
 * One test, because there is one contract: an absent API is a clean no-op.
 */
import { expect, test } from '@playwright/test';

test('feature-detects and no-ops without throwing', async ({ page }) => {
	const errors: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	page.on('pageerror', (error) => errors.push(error.message));

	await page.goto('/');

	await expect(page.getByTestId('support-status')).toHaveText(/unavailable/i);
	await expect(page.getByTestId('registered-count')).toHaveText('0/5');
	await expect(page.getByTestId('tool-manifest').getByRole('listitem')).toHaveCount(0);

	// The host page still rendered and is interactive, so the rune stayed out
	// of the way rather than taking the page down with it.
	await page.getByLabel('Add a todo').fill('Typed by a human');
	await page.getByRole('button', { name: 'Add' }).click();
	await expect(page.getByTestId('todo-list').getByText('Typed by a human')).toBeVisible();

	expect(errors).toEqual([]);
});
