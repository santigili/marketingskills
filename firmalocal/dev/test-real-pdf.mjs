import { chromium } from "playwright-core";
import { PDFDocument } from "pdf-lib";
import fs from "fs"; import path from "path";
const file = process.argv[2];
const ext = path.resolve("../extension");
const ctx = await chromium.launchPersistentContext("", { executablePath: "/opt/pw-browsers/chromium", headless: true, acceptDownloads: true,
  viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
const id = new URL(sw.url()).host;
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`chrome-extension://${id}/editor.html`);
await page.setInputFiles("#fileInput", file);
await page.waitForSelector(".page canvas", { timeout: 20000 });
await page.waitForTimeout(1500);
console.log("toast:", await page.locator("#toast").textContent());
const first = page.locator('input.field[type="text"]:not([disabled])').first();
if (await first.count()) { await first.fill("Prueba FirmaLocal Ñ"); console.log("filled", await first.getAttribute("data-field")); }
await page.screenshot({ path: "out/real-editor.png" });
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#downloadBtn")]);
await dl.saveAs("out/real-out.pdf");
await page.waitForTimeout(300);
console.log("toast after:", await page.locator("#toast").textContent());
const d = await PDFDocument.load(fs.readFileSync("out/real-out.pdf"));
console.log("output pages", d.getPageCount(), "fields left", d.getForm().getFields().length);
console.log("errors:", errors.length ? errors : "none");
await ctx.close();
