/**
 * Screenshot top section of homepage - ranking area
 * Run: npx tsx scripts/screenshot-top-section.ts
 */
import { chromium } from "playwright";
import { join } from "path";

const BASE = "http://localhost:3000";
const OUT_DIR = join(process.cwd(), "verification-screenshots");

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // Screenshot top section - full page width, first 700px height
  await page.screenshot({
    path: join(OUT_DIR, "homepage-top-section.png"),
    clip: { x: 0, y: 0, width: 1280, height: 700 },
  });

  // Check for expected elements
  const hasTopYeuThich = await page.locator('text=TOP YÊU THÍCH').isVisible().catch(() => false);
  const hasTopDocNhieu = await page.locator('text=TOP ĐỌC NHIỀU').isVisible().catch(() => false);
  const hasTopDeCu = await page.locator('text=TOP ĐỀ CỬ').isVisible().catch(() => false);
  const hasTopBinhLuan = await page.locator('text=TOP BÌNH LUẬN').isVisible().catch(() => false);
  const hasTruyenViet = await page.locator('text=Truyện Việt').isVisible().catch(() => false);

  console.log("=== Homepage Top Section Check ===");
  console.log("TOP YÊU THÍCH:", hasTopYeuThich);
  console.log("TOP ĐỌC NHIỀU:", hasTopDocNhieu);
  console.log("TOP ĐỀ CỬ:", hasTopDeCu);
  console.log("TOP BÌNH LUẬN:", hasTopBinhLuan);
  console.log("Truyện Việt toggle:", hasTruyenViet);
  console.log("\nScreenshot: verification-screenshots/homepage-top-section.png");

  await browser.close();
}

main().catch(console.error);
