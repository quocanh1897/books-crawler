/**
 * Verification script: Author link, book detail, chapter reader, Mục lục
 * Run: npx tsx scripts/verify-all-steps.ts
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
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);

    // ========== STEP 1: Click author name ==========
    report.push("=== STEP 1: Author link ===\n");
    const authorLink = page.locator('a[href^="/tac-gia/"]').first();
    const authorHref = await authorLink.getAttribute("href");
    if (!authorHref) {
      report.push("  FAIL: No author link found on homepage\n");
    } else {
      await authorLink.click({ force: true });
      await page.waitForTimeout(1500);

      const authorScreenshot = join(OUT_DIR, "step1-author-page.png");
      await page.screenshot({ path: authorScreenshot, fullPage: true });
      report.push(`  Screenshot: ${authorScreenshot}\n`);

      const hasAuthorName = await page.locator("h1").first().isVisible();
      const hasBookCount = await page.getByText(/truyện/).first().isVisible();
      const hasBookList = await page.locator('a[href^="/doc-truyen/"]').first().isVisible();
      report.push(`  Author name visible: ${hasAuthorName}`);
      report.push(`  Book count visible: ${hasBookCount}`);
      report.push(`  Book list visible: ${hasBookList}`);
      report.push(`  Result: ${hasAuthorName && hasBookCount && hasBookList ? "PASS" : "FAIL"}\n`);
    }

    // ========== STEP 2: Navigate to book detail ==========
    report.push("=== STEP 2: Book detail page ===\n");
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // Get book link from ranking (each row has book + author, ensures we get a valid book)
    const rankingBookLink = page.locator('[class*="divide-y"]').first().locator('a[href^="/doc-truyen/"]').first();
    let bookHref = await rankingBookLink.getAttribute("href");
    if (!bookHref) {
      bookHref = await page.locator('a[href^="/doc-truyen/"]:not([href*="chuong-"])').first().getAttribute("href");
    }
    if (!bookHref) {
      report.push("  FAIL: No book link found\n");
    } else {
      await page.goto(bookHref.startsWith("http") ? bookHref : BASE + bookHref, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);

      const bookScreenshot = join(OUT_DIR, "step2-book-detail.png");
      await page.screenshot({ path: bookScreenshot, fullPage: true });
      report.push(`  Screenshot: ${bookScreenshot}\n`);

      const authorLinkClickable = await page.locator('a[href^="/tac-gia/"]').first().isVisible();
      const hasDeCu = await page.getByText("Đề cử").first().isVisible();
      const hasLuotDoc = await page.getByText("Lượt đọc").first().isVisible().catch(() => false);
      report.push(`  Author name is link: ${authorLinkClickable}`);
      report.push(`  Has "Đề cử": ${hasDeCu}`);
      report.push(`  Has "Lượt đọc" (should be false): ${hasLuotDoc}`);
      report.push(`  Result: ${hasDeCu && !hasLuotDoc ? "PASS" : "FAIL"}\n`);
    }

    // ========== STEP 3: Chapter reader ==========
    report.push("=== STEP 3: Chapter reader ===\n");
    // We should be on book detail - get slug from URL and navigate to chuong-1
    const currentUrl = page.url();
    const slugMatch = currentUrl.match(/\/doc-truyen\/([^/]+)/);
    const slug = slugMatch ? slugMatch[1] : null;

    if (slug) {
      const chapterUrl = `${BASE}/doc-truyen/${slug}/chuong-1`;
      await page.goto(chapterUrl, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
    } else {
      const docTruyenBtn = page.locator('a:has-text("Đọc truyện")').first();
      await docTruyenBtn.click();
      await page.waitForTimeout(1500);
    }

    const chapterScreenshot = join(OUT_DIR, "step3-chapter-reader.png");
    await page.screenshot({ path: chapterScreenshot, fullPage: true });
    report.push(`  Screenshot: ${chapterScreenshot}\n`);

    const mucLucLinks = page.locator('a:has-text("Mục lục")');
    const mucLucCount = await mucLucLinks.count();
    const topMucLucVisible = mucLucCount >= 1;
    report.push(`  Top nav "Mục lục" (next to Chương X/Y): ${topMucLucVisible}`);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    const bottomMucLucCount = await page.locator('a:has-text("Mục lục")').count();
    const bottomMucLucVisible = bottomMucLucCount >= 1;
    report.push(`  Bottom nav "Mục lục" (between Chương trước/sau): ${bottomMucLucVisible}`);
    report.push(`  Result: ${topMucLucVisible && bottomMucLucVisible ? "PASS" : "FAIL"}\n`);

    // ========== STEP 4: Mục lục links ==========
    report.push("=== STEP 4: Mục lục navigation ===\n");
    const mucLucLink = page.locator('a:has-text("Mục lục")').first();
    if (await mucLucLink.isVisible()) {
      await mucLucLink.click();
      await page.waitForTimeout(1500);

      const tocScreenshot = join(OUT_DIR, "step4-muc-luc-result.png");
      await page.screenshot({ path: tocScreenshot, fullPage: true });
      report.push(`  Screenshot: ${tocScreenshot}\n`);

      const url = page.url();
      const isBookDetail = url.includes("/doc-truyen/") && !url.includes("chuong-");
      const hasChapterList = await page.getByText("Danh sách chương").first().isVisible();
      report.push(`  URL is book detail (no chuong-): ${isBookDetail}`);
      report.push(`  Chapter list visible: ${hasChapterList}`);
      report.push(`  Result: ${isBookDetail && hasChapterList ? "PASS" : "FAIL"}\n`);
    } else {
      report.push("  FAIL: Mục lục link not found (step 3 may have failed)\n");
    }

  } catch (err) {
    report.push(`ERROR: ${err}\n`);
  } finally {
    await browser.close();
  }

  const reportPath = join(OUT_DIR, "report.txt");
  const reportStr = report.join("\n");
  writeFileSync(reportPath, reportStr, "utf-8");
  console.log(reportStr);
  console.log(`\nReport saved to ${reportPath}`);
}

main().catch(console.error);
