/**
 * Count books in Đề cử tab with Truyện Việt OFF vs ON
 * Run: npx tsx scripts/count-ranking-books.ts
 */
import { chromium } from "playwright";

const BASE = "http://localhost:3000";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);

    const rankingSection = page.locator(".bg-white.rounded-lg.border").first();

    // 1. Truyện Việt OFF (default) - ensure it's OFF
    const toggle = page.locator('button[role="switch"]').first();
    let isOn = await toggle.getAttribute("aria-checked");
    if (isOn === "true") {
      await page.locator('label:has-text("Truyện Việt")').first().click();
      await page.waitForTimeout(500);
    }
    isOn = await toggle.getAttribute("aria-checked");
    console.log(`Toggle state before count: aria-checked=${isOn}`);

    // Count book rows - divs with role=link (clickable rows) to avoid counting wrappers
    const countOff = await rankingSection.locator(".divide-y > div[role='link']").count();
    const hasEmptyMsg = await rankingSection.locator('text=Chưa có dữ liệu').isVisible();
    const titlesOff = await rankingSection.locator(".divide-y p.text-sm.font-medium").allTextContents();
    console.log(`Truyện Việt OFF: ${countOff} books (empty msg: ${hasEmptyMsg})`);
    if (titlesOff.length > 0) console.log(`  Titles: ${titlesOff.slice(0, 3).map((t) => t.trim()).join(", ")}...`);

    // 2. Truyện Việt ON
    await page.locator('label:has-text("Truyện Việt")').first().click();
    await page.waitForTimeout(500);

    isOn = await toggle.getAttribute("aria-checked");
    const countOn = await rankingSection.locator(".divide-y > div[role='link']").count();
    const titlesOn = await rankingSection.locator(".divide-y p.text-sm.font-medium").allTextContents();
    console.log(`Truyện Việt ON: ${countOn} books (aria-checked=${isOn})`);
    if (titlesOn.length > 0) console.log(`  Titles: ${titlesOn.slice(0, 3).map((t) => t.trim()).join(", ")}...`);

    console.log(`\nReport: OFF=${countOff}, ON=${countOn}`);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
