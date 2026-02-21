/**
 * Verify Truyện Việt toggle on homepage ranking tabs
 * Run: npx tsx scripts/verify-truyen-viet-toggle.ts
 */
import { chromium } from "playwright";
import { writeFileSync } from "fs";
import { join } from "path";

const BASE = "http://localhost:3000";
const OUT_DIR = join(process.cwd(), "verification-screenshots");

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const report: string[] = [];

  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);

    // Screenshot 1: Before toggle
    const beforeScreenshot = join(OUT_DIR, "truyen-viet-toggle-before.png");
    const rankingSection = page.locator(".bg-white.rounded-lg.border").first();
    await rankingSection.screenshot({ path: beforeScreenshot });
    report.push("=== Truyện Việt Toggle Test ===\n");
    report.push(`  1. Screenshot (before): ${beforeScreenshot}\n`);

    // Get book names before toggle (from ranking list)
    const bookNamesBefore = await rankingSection.locator(".divide-y p.text-sm.font-medium").allTextContents();
    const beforeList = bookNamesBefore.slice(0, 5).map((t) => t.trim()).filter(Boolean);
    report.push(`  2. First 5 book names (toggle OFF): ${beforeList.join(", ")}\n`);

    // Find and click Truyện Việt toggle (the switch button or the label wrapping it)
    const toggle = page.locator('label:has-text("Truyện Việt")').first();
    const toggleVisible = await toggle.isVisible();
    report.push(`  3. Truyện Việt toggle found: ${toggleVisible}`);

    if (toggleVisible) {
      await toggle.click();
      await page.waitForTimeout(800);
    }

    // Screenshot 2: After toggle
    const afterScreenshot = join(OUT_DIR, "truyen-viet-toggle-after.png");
    await rankingSection.screenshot({ path: afterScreenshot });
    report.push(`\n  4. Screenshot (after): ${afterScreenshot}\n`);

    // Get book names after toggle
    const bookNamesAfter = await rankingSection.locator(".divide-y p.text-sm.font-medium").allTextContents();
    const afterList = bookNamesAfter.slice(0, 5).map((t) => t.trim()).filter(Boolean);
    report.push(`  5. First 5 book names (toggle ON): ${afterList.join(", ")}\n`);

    // Compare
    const listChanged = JSON.stringify(beforeList) !== JSON.stringify(afterList);
    report.push(`  6. Book list changed after toggle: ${listChanged ? "YES" : "NO"}`);

    // Check toggle visual state (aria-checked)
    const toggleChecked = await page.locator('button[role="switch"]').first().getAttribute("aria-checked");
    report.push(`  7. Toggle aria-checked after click: ${toggleChecked}`);

    // Summary
    report.push(`\n  Summary:`);
    report.push(`  - Toggle visually changes: ${toggleVisible ? "Expected (accent/gray)" : "N/A"}`);
    report.push(`  - Book list updates: ${listChanged ? "YES" : "NO (or no Vietnamese books in dataset)"}`);
  } catch (err) {
    report.push(`\nERROR: ${err}`);
  } finally {
    await browser.close();
  }

  const reportPath = join(OUT_DIR, "truyen-viet-report.txt");
  writeFileSync(reportPath, report.join("\n"), "utf-8");
  console.log(report.join("\n"));
  console.log(`\nReport saved to ${reportPath}`);
}

main().catch(console.error);
