import { expect, type Locator, type Page } from '@playwright/test';

/** Use the same progressive disclosures as a person; never force-click hidden controls. */
export async function openProjectActions(page: Page): Promise<void> {
  const summary = page.locator('summary[aria-label="Project actions"]');
  await expect(summary).toBeVisible();
  const opened = await summary.locator('..').evaluate(element => element.hasAttribute('open'));
  if (!opened) await summary.click();
}

export async function revealTaskDetails(drawer: Locator): Promise<void> {
  const summary = drawer.locator('summary').filter({ hasText: /^More details/ });
  await expect(summary).toBeVisible();
  const opened = await summary.locator('..').evaluate(element => element.hasAttribute('open'));
  if (!opened) await summary.click();
}

export async function closeProjectActions(page: Page): Promise<void> {
  const summary = page.locator('summary[aria-label="Project actions"]');
  if (await summary.count() && await summary.locator('..').evaluate(element => element.hasAttribute('open'))) await summary.click();
}

export async function showAllColumns(page: Page): Promise<void> {
  await closeProjectActions(page);
  const summary = page.locator('summary').filter({ hasText: /^View: (?:Daily view|All columns)$/ });
  await expect(summary).toBeVisible();
  if (!new URL(page.url()).searchParams.has('columns')) {
    await summary.click();
    const allColumns = page.getByRole('radio', { name: 'All columns', exact: true });
    await allColumns.click();
    await expect(page).toHaveURL(/(?:\?|&)columns=all(?:&|$)/);
    await expect(allColumns).toBeChecked();
    await summary.click();
  }
}

export async function revealTaskFilters(page: Page): Promise<void> {
  const summary = page.locator('summary').filter({ hasText: /^Filters(?: \(\d+\))?$/ });
  const opened = await summary.locator('..').evaluate(element => element.hasAttribute('open'));
  if (!opened) await summary.click();
}
