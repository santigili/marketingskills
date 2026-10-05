import { chromium } from "playwright-core";
import { PDFDocument } from "pdf-lib";
import fs from "fs";
import path from "path";

const ext = path.resolve("../extension");
const ctx = await chromium.launchPersistentContext("", {
  executablePath: "/opt/pw-browsers/chromium",
  headless: true,
  acceptDownloads: true,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const id = new URL(sw.url()).host;
console.log("extension id", id);

const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`chrome-extension://${id}/editor.html`);
await page.screenshot({ path: "out/01-inicio.png" });

await page.setInputFiles("#fileInput", "sample-form.pdf");
await page.waitForSelector(".field");
console.log("fields:", await page.locator(".field").count());

await page.fill('.field[data-field="nombre"]', "María Núñez García");
await page.fill('.field[data-field="dni"]', "12345678Z");
await page.selectOption('.field[data-field="provincia"]', "Valencia");
await page.check('.field[data-field="tipo"][value="empresa"]');
await page.check('.field[data-field="acepto"]');
await page.fill('.field[data-field="observaciones"]', "Entrega por la mañana.\nLlamar antes.");

const page1 = page.locator('.page[data-page="0"] .layer');
const box1 = await page1.boundingBox();
const s = await page.evaluate(() => __firmalocal.state.scale);
// Scrolls so the point (scale-1 coords on a page) is visible, then returns screen coords.
async function pt(pageIndex, x, y) {
  await page.evaluate(([i, y]) => {
    const el = document.querySelector(`.page[data-page="${i}"]`);
    const main = document.getElementById("main");
    main.scrollTop += el.getBoundingClientRect().top + y * __firmalocal.state.scale - main.clientHeight / 2;
  }, [pageIndex, y]);
  const b = await page.locator(`.page[data-page="${pageIndex}"] .layer`).boundingBox();
  return { x: b.x + x * s, y: b.y + y * s };
}

// Date next to "Fecha:" (PDF y=290 -> top coords 842-290)
await page.click('.tool[data-tool="date"]');
let p = await pt(0, 110, 842 - 294); await page.mouse.click(p.x, p.y);
// Text
await page.click('.tool[data-tool="text"]');
p = await pt(0, 330, 842 - 684); await page.mouse.click(p.x, p.y);
await page.keyboard.type("Cliente VIP");
// Check mark
await page.click('.tool[data-tool="check"]');
p = await pt(0, 520, 842 - 560); await page.mouse.click(p.x, p.y);

// Signature: draw
await page.click('.tool[data-tool="signature"]');
await page.waitForSelector("#sigDialog[open]");
const c = await page.locator("#sigCanvas").boundingBox();
await page.mouse.move(c.x + 60, c.y + 130); await page.mouse.down();
for (let i = 0; i <= 40; i++) await page.mouse.move(c.x + 60 + i * 10, c.y + 100 + Math.sin(i / 3) * 40);
await page.mouse.up();
await page.screenshot({ path: "out/02-firma-dialogo.png" });
await page.click("#acceptSig");
p = await pt(0, 290, 842 - 355); await page.mouse.click(p.x, p.y);

// Signature on rotated page 2 using saved signature
await page.locator('.page[data-page="1"]').scrollIntoViewIfNeeded();
await page.click('.tool[data-tool="signature"]');
await page.waitForSelector("#sigDialog[open]");
await page.click("#useSaved");
p = await pt(1, 842 - 110, 595 - 60); await page.mouse.click(p.x, p.y);
await page.click('.tool[data-tool="text"]');
p = await pt(1, 60, 40); await page.mouse.click(p.x, p.y);
await page.keyboard.type("Texto en página girada");

await page.locator('.page[data-page="0"]').scrollIntoViewIfNeeded();
await page.screenshot({ path: "out/03-editando.png" });

console.log("items:", JSON.stringify(await page.evaluate(() => __firmalocal.state.items.map(({page,kind,x,y,w,h,text,fontSize}) => ({page,kind,x:Math.round(x),y:Math.round(y),w:Math.round(w),h:Math.round(h),text,fontSize})))));
console.log("meta:", JSON.stringify(await page.evaluate(() => [...__firmalocal.state.fieldMeta])));
// Check values without flattening
await page.uncheck("#flatten");
const raw = await page.evaluate(async () => Array.from((await __firmalocal.buildPdf()).bytes));
const d1 = await PDFDocument.load(Uint8Array.from(raw));
const f = d1.getForm();
console.log("nombre:", f.getTextField("nombre").getText());
console.log("dni:", f.getTextField("dni").getText());
console.log("provincia:", f.getDropdown("provincia").getSelected());
console.log("tipo:", f.getRadioGroup("tipo").getSelected());
console.log("acepto:", f.getCheckBox("acepto").isChecked());
console.log("observaciones:", JSON.stringify(f.getTextField("observaciones").getText()));

// Download flattened
await page.check("#flatten");
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#downloadBtn")]);
const outPath = "out/" + dl.suggestedFilename();
await dl.saveAs(outPath);
console.log("downloaded:", outPath, fs.statSync(outPath).size, "bytes");
const d2 = await PDFDocument.load(fs.readFileSync(outPath));
console.log("fields after flatten:", d2.getForm().getFields().length);
await page.waitForTimeout(500);
await page.screenshot({ path: "out/04-descargado.png" });

// Render the downloaded file to PNGs with pdf.js inside the extension
const view = await ctx.newPage();
await view.goto(`chrome-extension://${id}/editor.html`);
const b64 = fs.readFileSync(outPath).toString("base64");
const pngs = await view.evaluate(async (b64) => {
  const pdfjs = await import("./vendor/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.mjs");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const pg = await pdf.getPage(i);
    const vp = pg.getViewport({ scale: 1.2 });
    const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
    await pg.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    out.push(c.toDataURL("image/png").split(",")[1]);
  }
  return out;
}, b64);
pngs.forEach((p, i) => fs.writeFileSync(`out/resultado-p${i + 1}.png`, Buffer.from(p, "base64")));

console.log("errors:", errors.length ? errors : "none");
await ctx.close();
