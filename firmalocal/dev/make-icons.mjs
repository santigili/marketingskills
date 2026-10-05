import { chromium } from "playwright-core";
import fs from "fs";
const svg = fs.readFileSync("icon.svg", "utf8");
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage();
for (const s of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: s, height: s });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" width="${s}" height="${s}">`);
  await page.screenshot({ path: `../extension/icons/icon${s}.png`, omitBackground: true });
}
await browser.close();
