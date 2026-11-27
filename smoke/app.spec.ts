import { expect, test } from "@playwright/test";

// Each run uses its own repo, so it starts from the starter rules and never touches the shared playground.
test("add a rule through chat, then review the sample diff end to end", async ({ page }, info) => {
  const repo = `smoke/${info.project.name}-${Date.now()}`;
  await page.goto("/");
  await expect(page.locator("#rules li")).toHaveCount(5);

  await page.fill("#repo", repo);
  await page.press("#repo", "Enter");
  await expect(page.locator("#repo")).toHaveValue(repo);

  // Memory: a rule added in chat lands in this repo's Durable Object.
  await page.getByRole("button", { name: "Add a rule" }).click();
  await expect(page.locator("#rules li")).toHaveCount(6, { timeout: 30_000 });
  await expect(page.locator("#rules li.user")).toContainText(/dependenc/i);

  // Workflow + LLM: the sample diff has a hardcoded key, so a high finding and "Changes requested" are expected.
  await page.getByRole("button", { name: "Review a sample diff" }).click();
  await expect(page.locator(".run")).toBeVisible();
  const report = page.locator(".report");
  await expect(report).toBeVisible({ timeout: 180_000 });
  await expect(report.locator(".verdict")).toHaveText("Changes requested");
  await expect(report.locator(".finding.high").first()).toBeVisible();

  // History: the finished review is saved to repo memory.
  await expect(page.locator("#history li").first()).toContainText("pasted diff");

  // Layout: long diffs and code blocks must not make the page scroll sideways (this broke mobile once).
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
