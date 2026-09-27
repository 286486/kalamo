import type { Page } from "@playwright/test";

/** Runs a Menu Item with the mouse: `choose(page, "File", "Export", "Export As SVG")`. */
export async function choose(page: Page, ...path: string[]) {
  for (const name of path)
    await page
      .getByRole("menuitem", { name, exact: true })
      .or(page.getByRole("menuitemcheckbox", { name, exact: true }))
      .click();
}
