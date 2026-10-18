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
  if (await summary.count()) {
    // Creation forms retain their explicit progressive disclosure.
    await expect(summary).toBeVisible();
    const opened = await summary.locator('..').evaluate(element => element.hasAttribute('open'));
    if (!opened) await summary.click();
    return;
  }
  // Saved task drawers expose these fields directly. A missing or still-loading
  // drawer must fail on its real controls rather than silently skipping setup.
  await expect(drawer.getByLabel('Team estimate, hours', { exact: true })).toBeVisible();
  await expect(drawer.getByRole('combobox', { name: 'Priority', exact: true })).toBeVisible();
}

export async function closeProjectActions(page: Page): Promise<void> {
  const summary = page.locator('summary[aria-label="Project actions"]');
  if (await summary.count() && await summary.locator('..').evaluate(element => element.hasAttribute('open'))) await summary.click();
}

export async function showAllColumns(page: Page): Promise<void> {
  await closeProjectActions(page);
  await page.getByRole('button', { name: /^Columns(?: · unsaved)?$/ }).click();
  const dialog = page.getByRole('dialog', { name: 'My task columns', exact: true });
  await expect(dialog.getByRole('button', { name: 'Use project defaults', exact: true })).toBeEnabled();
  const boxes = dialog.getByRole('checkbox');
  for (let index = 0; index < await boxes.count(); index++) {
    const box = boxes.nth(index);
    if (await box.isEnabled() && !await box.isChecked()) await box.check();
  }
  const save = dialog.getByRole('button', { name: 'Save columns', exact: true });
  if (await save.isEnabled()) {
    await save.click();
    await expect(dialog.getByText('Columns saved. Current settings refreshed.', { exact: true })).toBeVisible();
  }
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
}

export async function revealTaskFilters(page: Page): Promise<void> {
  const summary = page.locator('summary').filter({ hasText: /^Filters(?: \(\d+\))?$/ });
  const opened = await summary.locator('..').evaluate(element => element.hasAttribute('open'));
  if (!opened) await summary.click();
}
