/**
 * Verify rankings page and book detail stats
 * Run: npx tsx scripts/verify-rankings-and-book.ts
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
    // ========== STEP 1: Rankings page ==========
    report.push("=== STEP 1: Rankings page (/bang-xep-hang) ===\n");
    await page.goto(`${BASE}/bang-xep-hang`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    const step1Screenshot = join(OUT_DIR, "verify-step1-rankings.png");
    await page.screenshot({ path: step1Screenshot, fullPage: true });
    report.push(`  Screenshot: ${step1Screenshot}\n`);

    // Check "Đề cử" in filter pills
    const deCuPill = page.locator('a:has-text("Đề cử")').first();
    const deCuVisible = await deCuPill.isVisible();
    report.push(`  "Đề cử" in filter pills: ${deCuVisible}`);

    // Check if Đề cử is selected (has primary bg)
    const deCuSelected = await deCuPill.evaluate((el) => {
      const c = el.getAttribute("class") || "";
      return c.includes("bg-[var(--color-primary)]") || c.includes("primary");
    }).catch(() => false);
    report.push(`  "Đề cử" selected by default: ${deCuSelected}`);

    // Author links
    const authorLinks = await page.locator('a[href^="/tac-gia/"]').count();
    report.push(`  Author links in results: ${authorLinks}`);
    report.push(`  Result: ${deCuVisible && deCuSelected && authorLinks > 0 ? "PASS" : "FAIL"}\n`);

    // ========== STEP 2: Book detail page stats ==========
    report.push("=== STEP 2: Book detail page stats ===\n");
    // Stay on rankings page and click first book (ranking books have authors)
    const bookLink = page.locator('a[href^="/doc-truyen/"]:not([href*="chuong-"])').first();
    await bookLink.click({ force: true });
    await page.waitForTimeout(1000);

    const step2Screenshot = join(OUT_DIR, "verify-step2-book-stats.png");
    await page.screenshot({ path: step2Screenshot, fullPage: false });
    report.push(`  Screenshot: ${step2Screenshot}\n`);

    // First stat should be Đề cử (not Lượt đọc)
    const firstStatLabel = await page.locator(".flex.flex-wrap.gap-4 .text-center .text-xs").first().textContent();
    const hasDeCuFirst = firstStatLabel?.trim() === "Đề cử";
    const hasLuotDoc = await page.getByText("Lượt đọc").isVisible().catch(() => false);
    report.push(`  First stat label: "${firstStatLabel?.trim()}"`);
    report.push(`  First stat is "Đề cử": ${hasDeCuFirst}`);
    report.push(`  Has "Lượt đọc" (should be false): ${hasLuotDoc}`);

    // Author link with hover:underline
    const authorLink = page.locator('a[href^="/tac-gia/"]').first();
    const authorLinkVisible = await authorLink.isVisible();
    const authorHasHoverUnderline = await authorLink.evaluate((el) => {
      const c = el.getAttribute("class") || "";
      return c.includes("hover:underline");
    }).catch(() => false);
    report.push(`  Author link visible: ${authorLinkVisible}`);
    report.push(`  Author has hover:underline: ${authorHasHoverUnderline}`);
    report.push(`  Result: ${hasDeCuFirst && !hasLuotDoc && authorLinkVisible ? "PASS" : "FAIL"}\n`);

  } catch (err) {
    report.push(`ERROR: ${err}\n`);
  } finally {
    await browser.close();
  }

  const reportPath = join(OUT_DIR, "verify-report.txt");
  const reportStr = report.join("\n");
  writeFileSync(reportPath, reportStr, "utf-8");
  console.log(reportStr);
  console.log(`\nReport saved to ${reportPath}`);
}

main().catch(console.error);
