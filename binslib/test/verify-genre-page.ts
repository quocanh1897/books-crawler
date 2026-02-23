/**
 * Verify genre page ranking tabs
 * Run: npx tsx scripts/verify-genre-page.ts
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
    // Navigate to homepage
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // Click on a genre (Huyền Huyễn)
    const genreLink = page.locator('a[href^="/the-loai/"]').first();
    const genreHref = await genreLink.getAttribute("href");
    report.push(`=== Genre page verification ===\n`);
    report.push(`  Clicking genre: ${genreHref}\n`);

    await genreLink.click();
    await page.waitForTimeout(1500);

    // 1. Verify Đề cử is default selected
    const deCuTab = page.locator('button:has-text("Đề cử")').first();
    const deCuSelected = await deCuTab.evaluate((el) => {
      const c = el.getAttribute("class") || "";
      return c.includes("color-primary") || c.includes("primary");
    }).catch(() => false);
    report.push(`  1. Đề cử is default selected tab: ${deCuSelected ? "PASS" : "FAIL"}`);

    // 2. Verify Đề cử tab has data
    const emptyMsg = page.locator('text=Chưa có dữ liệu');
    const deCuHasData = !(await emptyMsg.isVisible());
    const deCuBookCount = await page.locator('a[href^="/doc-truyen/"]').count();
    report.push(`  2. Đề cử tab has book data: ${deCuHasData ? "PASS" : "FAIL"} (${deCuBookCount} books)`);

    // Screenshot of Đề cử tab
    const screenshotPath = join(OUT_DIR, "genre-page-de-cu-tab.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    report.push(`  Screenshot: ${screenshotPath}\n`);

    // 3. Switch to Yêu thích tab
    await page.locator('button:has-text("Yêu thích")').first().click();
    await page.waitForTimeout(500);
    const yeuThichEmpty = await emptyMsg.isVisible();
    const yeuThichBookCount = await page.locator('a[href^="/doc-truyen/"]').count();
    report.push(`  3. Yêu thích tab has data: ${!yeuThichEmpty ? "PASS" : "FAIL"} (${yeuThichBookCount} books)`);

    // 4. Switch to Bình luận tab
    await page.locator('button:has-text("Bình luận")').first().click();
    await page.waitForTimeout(500);
    const binhLuanEmpty = await emptyMsg.isVisible();
    const binhLuanBookCount = await page.locator('a[href^="/doc-truyen/"]').count();
    report.push(`  4. Bình luận tab has data: ${!binhLuanEmpty ? "PASS" : "FAIL"} (${binhLuanBookCount} books)`);

    report.push(`\n  Overall: ${deCuSelected && deCuHasData && !yeuThichEmpty && !binhLuanEmpty ? "ALL PASS" : "SOME FAIL"}`);

  } catch (err) {
    report.push(`\nERROR: ${err}`);
  } finally {
    await browser.close();
  }

  const reportPath = join(OUT_DIR, "genre-verify-report.txt");
  const reportStr = report.join("\n");
  writeFileSync(reportPath, reportStr, "utf-8");
  console.log(reportStr);
  console.log(`\nReport saved to ${reportPath}`);
}

main().catch(console.error);
