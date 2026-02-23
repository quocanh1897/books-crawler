/**
 * Verifies homepage features and captures a screenshot.
 * Run with: npx playwright test scripts/verify-homepage.ts (or use tsx + playwright)
 */
import { chromium } from "playwright";
import { writeFileSync } from "fs";
import { join } from "path";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });

  // Wait for content to render
  await page.waitForTimeout(2000);

  // Take screenshot
  const screenshotPath = join(process.cwd(), "homepage-verification.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`Screenshot saved to ${screenshotPath}`);

  // Verify features
  const report: string[] = [];

  // 1. Ranking Tabs - first tab should be "Đề cử", 3 tabs total
  const firstTab = await page.locator('button:has-text("Đề cử")').first().textContent();
  report.push(`1. Ranking Tabs: First tab="${firstTab?.trim()}" (expected "Đề cử")`);

  const tabButtons = await page.locator('div.flex button').allTextContents();
  report.push(`   Tab labels: ${JSON.stringify(tabButtons.slice(0, 5))}`);

  // 2. Download buttons in ranking
  const rankingDownloadBtns = await page.locator('[title="Tải epub"]').count();
  report.push(`2. Download buttons in ranking: ${rankingDownloadBtns} found`);

  // 3. Author links
  const authorLinks = await page.locator('a[href^="/tac-gia/"]').count();
  report.push(`3. Author links (clickable): ${authorLinks} found`);

  // 4. Mới cập nhật - đề cử + download
  const moiCapNhat = await page.getByRole("heading", { name: "Mới cập nhật", exact: true }).isVisible();
  const deCuInRows = await page.locator('text=đề cử').count();
  report.push(`4. Mới cập nhật section: visible=${moiCapNhat}, "đề cử" occurrences=${deCuInRows}`);

  // 5. Truyện đã hoàn thành
  const completedSection = await page.getByRole("heading", { name: "Truyện đã hoàn thành" }).isVisible();
  report.push(`5. Truyện đã hoàn thành: visible=${completedSection}`);

  console.log("\n--- Verification Report ---\n" + report.join("\n"));

  await browser.close();
}

main().catch(console.error);
