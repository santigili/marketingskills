// FirmaLocal editor: renders a PDF with pdf.js, lets the user fill form fields and
// place text, dates, marks and signatures, then writes a new PDF with pdf-lib.
// Everything runs in this page; the document never leaves the computer.

import * as pdfjsLib from "./vendor/pdf.min.mjs";
import { PDFDocument, StandardFonts, rgb, degrees } from "./vendor/pdf-lib.esm.min.js";

const asset = (p) => (globalThis.chrome?.runtime?.getURL ? chrome.runtime.getURL(p) : new URL(p, location.href).href);
pdfjsLib.GlobalWorkerOptions.workerSrc = asset("vendor/pdf.worker.min.mjs");

const $ = (id) => document.getElementById(id);
const els = {
  toolbar: $("toolbar"), subbar: $("subbar"), fileName: $("fileName"), flatten: $("flatten"),
  openBtn: $("openBtn"), openBtn2: $("openBtn2"), downloadBtn: $("downloadBtn"), fileInput: $("fileInput"),
  empty: $("empty"), dropZone: $("dropZone"), pages: $("pages"), main: $("main"),
  remoteBox: $("remoteBox"), remoteMsg: $("remoteMsg"), grantBtn: $("grantBtn"),
  hint: $("hint"), toast: $("toast"), fontSize: $("fontSize"),
  zoomIn: $("zoomIn"), zoomOut: $("zoomOut"), zoomLabel: $("zoomLabel"),
  sigDialog: $("sigDialog"), sigCanvas: $("sigCanvas"), sigText: $("sigText"), typePreview: $("typePreview"),
  sigFile: $("sigFile"), sigImgPreview: $("sigImgPreview"), rememberSig: $("rememberSig"),
  savedSig: $("savedSig"), savedImg: $("savedImg"), useSaved: $("useSaved"), deleteSaved: $("deleteSaved"),
  clearSig: $("clearSig"), cancelSig: $("cancelSig"), acceptSig: $("acceptSig")
};

const TEXT_COLOR = rgb(0.07, 0.07, 0.07);
const LINE_HEIGHT = 1.2;
const BASELINE = 0.95; // baseline position inside a CSS line box of LINE_HEIGHT, as a fraction of font size

const state = {
  bytes: null,          // original PDF bytes (never modified)
  name: "documento.pdf",
  pdf: null,            // pdf.js document
  pages: [],            // { proxy, base (scale-1 viewport), rotate, annots, el, layer }
  scale: 1,
  fieldValues: new Map(), // fieldName -> value
  fieldMeta: new Map(),   // fieldName -> { type }
  touched: new Set(),     // fieldNames the user changed
  items: [],              // { id, page, kind: text|image|check|cross, x, y, w, h, text, fontSize, src }
  tool: null,
  pendingImage: null,     // signature data URL waiting to be placed
  selected: null,
  dirty: false,
  renderToken: 0
};

// ---------- small helpers ----------

let toastTimer;
function toast(msg, isError = false, ms = 3200) {
  els.toast.textContent = msg;
  els.toast.classList.toggle("error", isError);
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), ms);
}

const storage = {
  async get(key) {
    try {
      if (globalThis.chrome?.storage?.local) return (await chrome.storage.local.get(key))[key];
      return JSON.parse(localStorage.getItem(key) ?? "null");
    } catch { return null; }
  },
  async set(key, value) {
    try {
      if (globalThis.chrome?.storage?.local) return await chrome.storage.local.set({ [key]: value });
      localStorage.setItem(key, JSON.stringify(value));
    } catch { /* storage is a convenience only */ }
  },
  async remove(key) {
    try {
      if (globalThis.chrome?.storage?.local) return await chrome.storage.local.remove(key);
      localStorage.removeItem(key);
    } catch { /* ignore */ }
  }
};

function todayString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

const measureCtx = document.createElement("canvas").getContext("2d");
function measureText(text, size) {
  measureCtx.font = `${size}px Helvetica, Arial, sans-serif`;
  const lines = text.split("\n");
  const width = Math.max(...lines.map((l) => measureCtx.measureText(l || " ").width));
  return { width: width + size * 0.4, height: lines.length * size * LINE_HEIGHT };
}

function dataUrlToBytes(dataUrl) {
  const bin = atob(dataUrl.split(",")[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- loading ----------

async function loadPdf(arrayBuffer, name) {
  const bytes = new Uint8Array(arrayBuffer);
  if (state.dirty && !confirm("Tienes cambios sin descargar en el PDF actual. ¿Abrir otro igualmente?")) return;

  // pdf-lib must be able to write this file, so check that first.
  try {
    await PDFDocument.load(bytes);
  } catch (err) {
    if (/encrypt/i.test(err?.message || "")) {
      toast("Este PDF está protegido (cifrado). FirmaLocal todavía no puede modificar PDFs protegidos.", true, 6000);
    } else {
      toast("No se pudo abrir el archivo. ¿Seguro que es un PDF válido?", true, 5000);
    }
    return;
  }

  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({
      data: bytes.slice(),
      cMapUrl: asset("vendor/cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: asset("vendor/standard_fonts/"),
      wasmUrl: asset("vendor/wasm/"),
      iccUrl: asset("vendor/iccs/"),
      isEvalSupported: false,
      enableXfa: false
    }).promise;
  } catch {
    toast("No se pudo leer este PDF.", true, 5000);
    return;
  }

  state.bytes = bytes;
  state.name = name || "documento.pdf";
  state.pdf = pdf;
  state.items = [];
  state.fieldValues = new Map();
  state.fieldMeta = new Map();
  state.touched = new Set();
  state.selected = null;
  state.dirty = false;
  setTool(null);

  state.pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const proxy = await pdf.getPage(i);
    const annots = (await proxy.getAnnotations({ intent: "display" })).filter(isEditableWidget);
    for (const a of annots) initFieldValue(a);
    state.pages.push({ proxy, base: proxy.getViewport({ scale: 1 }), rotate: proxy.rotate, annots });
  }

  els.empty.hidden = true;
  els.pages.hidden = false;
  els.toolbar.hidden = false;
  els.subbar.hidden = false;
  els.downloadBtn.hidden = false;
  els.fileName.textContent = state.name;
  document.title = `${state.name} · FirmaLocal`;

  state.scale = fitScale();
  await renderAll();
  const nFields = state.fieldMeta.size;
  toast(nFields
    ? `PDF abierto. Tiene ${nFields} campo${nFields === 1 ? "" : "s"} para rellenar.`
    : "PDF abierto. Usa Texto, Firma o Fecha para escribir en él.");
}

function isEditableWidget(a) {
  if (a.subtype !== "Widget" || !a.fieldName) return false;
  if (a.fieldType === "Btn" && a.pushButton) return false;
  return ["Tx", "Btn", "Ch"].includes(a.fieldType);
}

function initFieldValue(a) {
  const name = a.fieldName;
  if (state.fieldMeta.has(name)) return;
  let type;
  let value;
  if (a.fieldType === "Tx") {
    type = "text";
    value = Array.isArray(a.fieldValue) ? a.fieldValue.join("") : (a.fieldValue ?? "");
  } else if (a.fieldType === "Btn" && a.radioButton) {
    type = "radio";
    value = a.fieldValue && a.fieldValue !== "Off" ? a.fieldValue : null;
  } else if (a.fieldType === "Btn") {
    type = "checkbox";
    value = !!a.fieldValue && a.fieldValue !== "Off";
  } else {
    type = "choice";
    value = Array.isArray(a.fieldValue) ? (a.fieldValue[0] ?? "") : (a.fieldValue ?? "");
  }
  state.fieldMeta.set(name, { type, daSize: a.defaultAppearanceData?.fontSize || 0, multiLine: !!a.multiLine, height: Math.abs(a.rect[3] - a.rect[1]) });
  state.fieldValues.set(name, value);
}

// Font size (PDF points) used for a text field: its own size, or a readable default
// when the PDF says "auto" (0), which otherwise makes multi-line text huge.
function fieldFontSize(meta) {
  if (meta.daSize && !(meta.multiLine && meta.daSize > 24)) return meta.daSize;
  if (meta.multiLine) return 11;
  return Math.max(7, Math.min(12, meta.height * 0.62));
}

function fitScale() {
  if (!state.pages.length) return 1;
  const widest = Math.max(...state.pages.map((p) => p.base.width));
  const avail = Math.max(320, els.main.clientWidth - 48);
  return Math.min(1.6, Math.max(0.4, avail / widest));
}

// ---------- rendering ----------

async function renderAll() {
  const token = ++state.renderToken;
  const scrollRatio = els.main.scrollHeight ? els.main.scrollTop / els.main.scrollHeight : 0;
  els.pages.replaceChildren();
  els.zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

  const renders = [];
  state.pages.forEach((p, index) => {
    const vp = p.proxy.getViewport({ scale: state.scale });
    const pageEl = document.createElement("div");
    pageEl.className = "page";
    pageEl.style.width = `${vp.width}px`;
    pageEl.style.height = `${vp.height}px`;
    pageEl.dataset.page = index;

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${vp.width}px`;
    canvas.style.height = `${vp.height}px`;

    const layer = document.createElement("div");
    layer.className = "layer";
    layer.addEventListener("pointerdown", (e) => onLayerPointerDown(e, index));

    pageEl.append(canvas, layer);
    els.pages.append(pageEl);
    p.el = pageEl;
    p.layer = layer;
    p.vp = vp;

    renders.push(p.proxy.render({
      canvasContext: canvas.getContext("2d"),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
      annotationMode: pdfjsLib.AnnotationMode.ENABLE // draws widgets without their values; we overlay inputs
    }).promise.catch(() => {}));

    for (const a of p.annots) layer.append(createFieldEl(a, vp));
    for (const item of state.items.filter((it) => it.page === index)) layer.append(createItemEl(item));
  });

  await Promise.all(renders);
  if (token !== state.renderToken) return;
  els.main.scrollTop = scrollRatio * els.main.scrollHeight;
}

function rectToCss(rect, vp) {
  const [x1, y1] = vp.convertToViewportPoint(rect[0], rect[1]);
  const [x2, y2] = vp.convertToViewportPoint(rect[2], rect[3]);
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

function createFieldEl(a, vp) {
  const name = a.fieldName;
  const meta = state.fieldMeta.get(name);
  const box = rectToCss(a.rect, vp);
  let el;

  if (meta.type === "text") {
    el = document.createElement(a.multiLine ? "textarea" : "input");
    if (!a.multiLine) el.type = "text";
    el.value = state.fieldValues.get(name) ?? "";
    if (a.maxLen) el.maxLength = a.maxLen;
    el.style.fontSize = `${fieldFontSize(meta) * state.scale}px`;
    if (a.textAlignment === 1) el.style.textAlign = "center";
    if (a.textAlignment === 2) el.style.textAlign = "right";
    el.addEventListener("input", () => setFieldValue(name, el.value, el));
  } else if (meta.type === "checkbox") {
    el = document.createElement("input");
    el.type = "checkbox";
    el.checked = !!state.fieldValues.get(name);
    el.addEventListener("change", () => setFieldValue(name, el.checked, el));
  } else if (meta.type === "radio") {
    el = document.createElement("input");
    el.type = "radio";
    el.name = `radio-${name}`;
    el.value = a.buttonValue;
    el.checked = state.fieldValues.get(name) === a.buttonValue;
    el.addEventListener("change", () => el.checked && setFieldValue(name, a.buttonValue, el));
  } else {
    el = document.createElement("select");
    for (const o of a.options || []) {
      const opt = document.createElement("option");
      opt.value = o.exportValue ?? o.displayValue;
      opt.textContent = o.displayValue ?? o.exportValue;
      el.append(opt);
    }
    el.value = state.fieldValues.get(name) ?? "";
    el.style.fontSize = `${Math.max(7, Math.min(box.height * 0.65, 12 * state.scale))}px`;
    el.addEventListener("change", () => setFieldValue(name, el.value, el));
  }

  el.classList.add("field");
  el.dataset.field = name;
  el.title = a.alternativeText || name;
  if (a.readOnly) el.disabled = true;
  Object.assign(el.style, {
    left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`
  });
  if (meta.type === "checkbox" || meta.type === "radio") {
    const s = Math.min(box.width, box.height);
    Object.assign(el.style, {
      width: `${s}px`, height: `${s}px`,
      left: `${box.left + (box.width - s) / 2}px`, top: `${box.top + (box.height - s) / 2}px`
    });
  }
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  return el;
}

function setFieldValue(name, value, source) {
  state.fieldValues.set(name, value);
  state.touched.add(name);
  state.dirty = true;
  // Keep other widgets of the same field in sync (same field shown twice, radio groups).
  for (const other of els.pages.querySelectorAll(".field")) {
    if (other === source || other.dataset.field !== name) continue;
    if (other.type === "checkbox") other.checked = !!value;
    else if (other.type === "radio") other.checked = other.value === value;
    else other.value = value;
  }
}

// ---------- added items (text, date, marks, signatures) ----------

function createItemEl(item) {
  const s = state.scale;
  const el = document.createElement("div");
  el.className = "item";
  el.dataset.id = item.id;
  positionItemEl(el, item);

  const bar = document.createElement("div");
  bar.className = "bar";
  const move = document.createElement("button");
  move.className = "move";
  move.title = "Mover";
  move.textContent = "✥";
  const del = document.createElement("button");
  del.title = "Eliminar";
  del.textContent = "✕";
  del.addEventListener("click", (e) => { e.stopPropagation(); removeItem(item.id); });
  bar.append(move, del);

  const handle = document.createElement("div");
  handle.className = "handle";
  handle.title = "Cambiar tamaño";

  if (item.kind === "text") {
    const ta = document.createElement("textarea");
    ta.value = item.text;
    ta.spellcheck = false;
    ta.style.fontSize = `${item.fontSize * s}px`;
    ta.addEventListener("input", () => {
      item.text = ta.value;
      const m = measureText(item.text, item.fontSize);
      item.w = m.width;
      item.h = m.height;
      positionItemEl(el, item);
      state.dirty = true;
    });
    ta.addEventListener("focus", () => select(item.id));
    ta.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.append(ta);
    startDrag(move, el, item, "move");
  } else {
    el.classList.add("img-item");
    if (item.kind === "image") {
      const img = document.createElement("img");
      img.src = item.src;
      img.alt = "Firma";
      el.append(img);
    } else {
      el.innerHTML = markSvg(item.kind);
    }
    startDrag(el, el, item, "move");
    startDrag(move, el, item, "move");
  }
  startDrag(handle, el, item, "resize");
  el.append(bar, handle);
  el.addEventListener("pointerdown", (e) => { e.stopPropagation(); select(item.id); });
  return el;
}

function markSvg(kind) {
  const path = kind === "check" ? "M15 55 L40 80 L85 20" : "M20 20 L80 80 M80 20 L20 80";
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none"><path d="${path}" fill="none" stroke="#111" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function positionItemEl(el, item) {
  const s = state.scale;
  Object.assign(el.style, {
    left: `${item.x * s}px`, top: `${item.y * s}px`, width: `${item.w * s}px`, height: `${item.h * s}px`
  });
}

function startDrag(trigger, el, item, mode) {
  trigger.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    select(item.id);
    trigger.setPointerCapture(e.pointerId);
    const s = state.scale;
    const start = { x: e.clientX, y: e.clientY, ix: item.x, iy: item.y, iw: item.w, ih: item.h, fs: item.fontSize };
    const page = state.pages[item.page].base;

    const onMove = (ev) => {
      const dx = (ev.clientX - start.x) / s;
      const dy = (ev.clientY - start.y) / s;
      if (mode === "move") {
        item.x = Math.min(Math.max(start.ix + dx, -item.w / 2), page.width - item.w / 2);
        item.y = Math.min(Math.max(start.iy + dy, -item.h / 2), page.height - item.h / 2);
      } else {
        const ratio = start.ih / start.iw;
        const w = Math.max(10, start.iw + dx);
        if (item.kind === "text") {
          item.fontSize = Math.max(5, Math.min(72, start.fs * (w / start.iw)));
          const m = measureText(item.text, item.fontSize);
          item.w = m.width;
          item.h = m.height;
          el.querySelector("textarea").style.fontSize = `${item.fontSize * s}px`;
        } else {
          item.w = w;
          item.h = w * ratio;
        }
      }
      positionItemEl(el, item);
      state.dirty = true;
    };
    const onUp = () => {
      trigger.removeEventListener("pointermove", onMove);
      trigger.removeEventListener("pointerup", onUp);
      trigger.removeEventListener("pointercancel", onUp);
    };
    trigger.addEventListener("pointermove", onMove);
    trigger.addEventListener("pointerup", onUp);
    trigger.addEventListener("pointercancel", onUp);
  });
}

function select(id) {
  state.selected = id;
  for (const el of els.pages.querySelectorAll(".item")) el.classList.toggle("selected", el.dataset.id === id);
}

function removeItem(id) {
  state.items = state.items.filter((it) => it.id !== id);
  els.pages.querySelector(`.item[data-id="${id}"]`)?.remove();
  if (state.selected === id) state.selected = null;
  state.dirty = true;
}

function addItem(item) {
  item.id = crypto.randomUUID();
  state.items.push(item);
  const el = createItemEl(item);
  state.pages[item.page].layer.append(el);
  select(item.id);
  state.dirty = true;
  if (item.kind === "text") {
    const ta = el.querySelector("textarea");
    ta.focus();
    ta.select();
  }
}

// ---------- tools ----------

const HINTS = {
  text: "Haz clic donde quieras escribir",
  date: "Haz clic donde quieras poner la fecha",
  check: "Haz clic donde quieras poner la marca",
  cross: "Haz clic donde quieras poner la cruz",
  signature: "Haz clic donde quieras colocar la firma"
};

function setTool(tool) {
  state.tool = tool;
  for (const b of els.toolbar.querySelectorAll(".tool")) b.classList.toggle("active", b.dataset.tool === tool);
  els.pages.classList.toggle("placing", !!tool);
  els.hint.hidden = !tool;
  if (tool) els.hint.textContent = `${HINTS[tool]} · Esc para cancelar`;
  if (!tool) state.pendingImage = null;
}

function onToolClick(tool) {
  if (state.tool === tool) return setTool(null);
  if (tool === "signature") return openSignatureDialog();
  setTool(tool);
}

function onLayerPointerDown(e, pageIndex) {
  if (!state.tool) {
    select(null);
    if (document.activeElement?.tagName === "TEXTAREA") document.activeElement.blur();
    return;
  }
  e.preventDefault();
  const rect = state.pages[pageIndex].layer.getBoundingClientRect();
  const x = (e.clientX - rect.left) / state.scale;
  const y = (e.clientY - rect.top) / state.scale;
  const tool = state.tool;

  if (tool === "text" || tool === "date") {
    const fontSize = Number(els.fontSize.value) || 11;
    const text = tool === "date" ? todayString() : "Escribe aquí";
    const m = measureText(text, fontSize);
    addItem({ page: pageIndex, kind: "text", x, y: y - m.height / 2, w: m.width, h: m.height, text, fontSize });
  } else if (tool === "check" || tool === "cross") {
    const size = 14;
    addItem({ page: pageIndex, kind: tool, x: x - size / 2, y: y - size / 2, w: size, h: size });
  } else if (tool === "signature" && state.pendingImage) {
    const { src, ratio } = state.pendingImage;
    const w = 160;
    const h = w * ratio;
    addItem({ page: pageIndex, kind: "image", x: x - w / 2, y: y - h / 2, w, h, src });
  }
  setTool(null);
}

// ---------- signature dialog ----------

const sig = { tab: "draw", hasInk: false, imageData: null };
const sigCtx = els.sigCanvas.getContext("2d");

async function openSignatureDialog() {
  const saved = await storage.get("signature");
  els.savedSig.hidden = !saved;
  if (saved) els.savedImg.src = saved;
  switchTab("draw");
  clearCanvas();
  els.sigText.value = "";
  renderTypePreview();
  els.sigFile.value = "";
  els.sigImgPreview.hidden = true;
  sig.imageData = null;
  els.sigDialog.showModal();
}

function switchTab(tab) {
  sig.tab = tab;
  for (const t of els.sigDialog.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.tab === tab);
  for (const p of els.sigDialog.querySelectorAll(".tab-panel")) p.hidden = p.dataset.panel !== tab;
  if (tab === "type") els.sigText.focus();
}

function clearCanvas() {
  sigCtx.clearRect(0, 0, els.sigCanvas.width, els.sigCanvas.height);
  sig.hasInk = false;
}

(function setupDrawing() {
  let last = null;
  const pos = (e) => {
    const r = els.sigCanvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (els.sigCanvas.width / r.width), y: (e.clientY - r.top) * (els.sigCanvas.height / r.height) };
  };
  els.sigCanvas.addEventListener("pointerdown", (e) => {
    els.sigCanvas.setPointerCapture(e.pointerId);
    last = pos(e);
    sigCtx.beginPath();
    sigCtx.arc(last.x, last.y, 1.4, 0, Math.PI * 2);
    sigCtx.fillStyle = "#111";
    sigCtx.fill();
    sig.hasInk = true;
  });
  els.sigCanvas.addEventListener("pointermove", (e) => {
    if (!last) return;
    const p = pos(e);
    sigCtx.strokeStyle = "#111";
    sigCtx.lineWidth = 3;
    sigCtx.lineCap = "round";
    sigCtx.lineJoin = "round";
    sigCtx.beginPath();
    sigCtx.moveTo(last.x, last.y);
    sigCtx.lineTo(p.x, p.y);
    sigCtx.stroke();
    last = p;
  });
  const end = () => { last = null; };
  els.sigCanvas.addEventListener("pointerup", end);
  els.sigCanvas.addEventListener("pointercancel", end);
})();

const SCRIPT_FONT = '"Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive';
function renderTypePreview() {
  els.typePreview.textContent = els.sigText.value || "Tu nombre";
  els.typePreview.style.color = els.sigText.value ? "#111" : "#999";
}

// Crops transparent margins and returns { src, ratio } for a canvas.
function trimCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 6;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d").drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return { src: out.toDataURL("image/png"), ratio: out.height / out.width };
}

function typedSignature() {
  const text = els.sigText.value.trim();
  if (!text) return null;
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  const size = 110;
  ctx.font = `${size}px ${SCRIPT_FONT}`;
  c.width = Math.ceil(ctx.measureText(text).width + size);
  c.height = Math.ceil(size * 1.8);
  ctx.font = `${size}px ${SCRIPT_FONT}`;
  ctx.fillStyle = "#111";
  ctx.textBaseline = "middle";
  ctx.fillText(text, size / 2, c.height / 2);
  return trimCanvas(c);
}

function loadImageSignature(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const maxW = 1200;
      const k = Math.min(1, maxW / img.width);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, c.width, c.height);
      // Make the light background transparent so the signature sits on the document.
      const id = ctx.getImageData(0, 0, c.width, c.height);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (lum > 215) d[i + 3] = 0;
      }
      ctx.putImageData(id, 0, 0);
      sig.imageData = trimCanvas(c);
      if (sig.imageData) {
        els.sigImgPreview.src = sig.imageData.src;
        els.sigImgPreview.hidden = false;
      } else {
        toast("No se ha encontrado ninguna firma en la imagen.", true);
      }
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function imageRatio(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.height / img.width);
    img.onerror = () => resolve(0.35);
    img.src = src;
  });
}

async function acceptSignature(result) {
  if (!result) {
    toast(sig.tab === "draw" ? "Dibuja tu firma primero." : sig.tab === "type" ? "Escribe tu nombre primero." : "Elige una imagen primero.", true);
    return;
  }
  if (els.rememberSig.checked) await storage.set("signature", result.src);
  els.sigDialog.close();
  setTool("signature");
  state.pendingImage = result;
}

els.sigDialog.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
els.clearSig.addEventListener("click", clearCanvas);
els.sigText.addEventListener("input", renderTypePreview);
els.sigFile.addEventListener("change", () => els.sigFile.files[0] && loadImageSignature(els.sigFile.files[0]));
els.cancelSig.addEventListener("click", () => els.sigDialog.close());
els.acceptSig.addEventListener("click", () => {
  if (sig.tab === "draw") acceptSignature(sig.hasInk ? trimCanvas(els.sigCanvas) : null);
  else if (sig.tab === "type") acceptSignature(typedSignature());
  else acceptSignature(sig.imageData);
});
els.useSaved.addEventListener("click", async () => {
  const src = await storage.get("signature");
  if (!src) return;
  els.sigDialog.close();
  setTool("signature");
  state.pendingImage = { src, ratio: await imageRatio(src) };
});
els.deleteSaved.addEventListener("click", async () => {
  await storage.remove("signature");
  els.savedSig.hidden = true;
  toast("Firma guardada borrada de este ordenador.");
});

// ---------- writing the PDF ----------

function makeSanitizer(font) {
  const ok = new Map();
  return (text) => [...text.replace(/\t/g, "    ").replace(/\r\n?/g, "\n")].map((ch) => {
    if (ch === "\n") return ch;
    if (!ok.has(ch)) {
      try { font.encodeText(ch); ok.set(ch, true); } catch { ok.set(ch, false); }
    }
    return ok.get(ch) ? ch : "?";
  }).join("");
}

async function buildPdf() {
  const doc = await PDFDocument.load(state.bytes, { updateMetadata: false });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const clean = makeSanitizer(helv);
  const warnings = [];

  if (state.fieldMeta.size) {
    const form = doc.getForm();
    for (const name of state.touched) {
      const value = state.fieldValues.get(name);
      const type = state.fieldMeta.get(name)?.type;
      try {
        const field = form.getField(name);
        if (type === "text") {
          const max = field.getMaxLength?.();
          const v = clean(String(value ?? ""));
          const meta = state.fieldMeta.get(name);
          if (fieldFontSize(meta) !== meta.daSize) { try { field.setFontSize(fieldFontSize(meta)); } catch { /* keep the PDF's own size */ } }
          field.setText(max ? v.slice(0, max) : v);
        } else if (type === "checkbox") {
          value ? field.check() : field.uncheck();
        } else if (type === "radio") {
          if (value) field.select(value);
        } else if (type === "choice") {
          if (value) field.select(value);
        }
      } catch {
        warnings.push(name);
      }
    }
    if (els.flatten.checked) {
      try {
        form.updateFieldAppearances(helv);
        form.flatten();
      } catch {
        warnings.push("__flatten");
      }
    }
  }

  const pdfPages = doc.getPages();
  const images = new Map();
  for (const item of state.items) {
    const info = state.pages[item.page];
    const page = pdfPages[item.page];
    const vp = info.base;
    const rot = degrees(info.rotate || 0);
    const pt = (x, y) => vp.convertToPdfPoint(x, y);

    if (item.kind === "image") {
      let img = images.get(item.src);
      if (!img) {
        img = await doc.embedPng(dataUrlToBytes(item.src));
        images.set(item.src, img);
      }
      const [x, y] = pt(item.x, item.y + item.h);
      page.drawImage(img, { x, y, width: item.w, height: item.h, rotate: rot });
    } else if (item.kind === "text") {
      item.text.split("\n").forEach((line, i) => {
        if (!line.trim()) return;
        const [x, y] = pt(item.x, item.y + (i * LINE_HEIGHT + BASELINE) * item.fontSize);
        page.drawText(clean(line), { x, y, size: item.fontSize, font: helv, color: TEXT_COLOR, rotate: rot });
      });
    } else {
      const segs = item.kind === "check"
        ? [[[0.15, 0.55], [0.4, 0.8]], [[0.4, 0.8], [0.85, 0.2]]]
        : [[[0.2, 0.2], [0.8, 0.8]], [[0.8, 0.2], [0.2, 0.8]]];
      for (const [[ax, ay], [bx, by]] of segs) {
        const [sx, sy] = pt(item.x + ax * item.w, item.y + ay * item.h);
        const [ex, ey] = pt(item.x + bx * item.w, item.y + by * item.h);
        page.drawLine({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: Math.max(0.8, item.w * 0.12), color: TEXT_COLOR, lineCap: 1 });
      }
    }
  }

  return { bytes: await doc.save(), warnings };
}

async function download() {
  if (document.activeElement?.blur) document.activeElement.blur();
  els.downloadBtn.disabled = true;
  els.downloadBtn.textContent = "Preparando…";
  try {
    const { bytes, warnings } = await buildPdf();
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = state.name.replace(/\.pdf$/i, "") + "-firmado.pdf";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    state.dirty = false;
    if (warnings.includes("__flatten")) {
      toast("Descargado. No se pudo bloquear el formulario, así que los campos siguen siendo editables.", false, 6000);
    } else if (warnings.length) {
      toast(`Descargado, pero ${warnings.length} campo(s) no se pudieron guardar. Revísalos o usa la herramienta Texto.`, true, 7000);
    } else {
      toast("PDF descargado.");
    }
  } catch (err) {
    console.error(err);
    toast("No se pudo crear el PDF. Prueba con otro archivo o escríbenos.", true, 6000);
  } finally {
    els.downloadBtn.disabled = false;
    els.downloadBtn.textContent = "Descargar PDF";
  }
}

// ---------- opening files and URLs ----------

function openFile(file) {
  if (!file) return;
  if (file.type && file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
    toast("Ese archivo no es un PDF.", true);
    return;
  }
  file.arrayBuffer().then((buf) => loadPdf(buf, file.name));
}

async function openFromUrl(src) {
  let url;
  try { url = new URL(src); } catch { return; }
  const name = decodeURIComponent(url.pathname.split("/").pop() || "documento.pdf");
  els.remoteBox.hidden = false;
  els.grantBtn.hidden = true;

  if (url.protocol === "file:") {
    els.remoteMsg.textContent = "Para abrir un PDF de tu ordenador, pulsa «Elegir un PDF» o arrástralo aquí.";
    return;
  }
  els.remoteMsg.textContent = `Abriendo ${name}…`;
  try {
    const res = await fetch(url.href, { credentials: "include" });
    if (!res.ok) throw new Error(String(res.status));
    const buf = await res.arrayBuffer();
    els.remoteBox.hidden = true;
    await loadPdf(buf, name);
  } catch {
    const origin = `${url.origin}/*`;
    const has = globalThis.chrome?.permissions ? await chrome.permissions.contains({ origins: [origin] }) : true;
    if (!has) {
      els.remoteMsg.textContent = `Para abrir este PDF, FirmaLocal necesita permiso para leer archivos de ${url.hostname}. Solo se descarga el PDF a tu ordenador.`;
      els.grantBtn.hidden = false;
      els.grantBtn.onclick = async () => {
        if (await chrome.permissions.request({ origins: [origin] })) openFromUrl(src);
      };
    } else {
      els.remoteMsg.textContent = "No se pudo descargar este PDF. Descárgalo a tu ordenador y ábrelo con «Elegir un PDF».";
    }
  }
}

// ---------- wiring ----------

els.openBtn.addEventListener("click", () => els.fileInput.click());
els.openBtn2.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => { openFile(els.fileInput.files[0]); els.fileInput.value = ""; });
els.downloadBtn.addEventListener("click", download);
els.toolbar.querySelectorAll(".tool").forEach((b) => b.addEventListener("click", () => onToolClick(b.dataset.tool)));
els.zoomIn.addEventListener("click", () => { state.scale = Math.min(3, state.scale * 1.2); renderAll(); });
els.zoomOut.addEventListener("click", () => { state.scale = Math.max(0.3, state.scale / 1.2); renderAll(); });

["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => {
  e.preventDefault();
  els.dropZone.classList.add("over");
}));
["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => {
  e.preventDefault();
  if (ev === "dragleave" && e.relatedTarget) return;
  els.dropZone.classList.remove("over");
}));
document.addEventListener("drop", (e) => openFile(e.dataTransfer?.files?.[0]));

document.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName) || els.sigDialog.open;
  if (e.key === "Escape" && state.tool) return setTool(null);
  if (typing || !state.pdf) return;
  if ((e.key === "Delete" || e.key === "Backspace") && state.selected) { e.preventDefault(); removeItem(state.selected); }
  else if (e.key === "t" || e.key === "T") onToolClick("text");
  else if (e.key === "f" || e.key === "F") onToolClick("signature");
  else if (e.key === "d" || e.key === "D") onToolClick("date");
});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
});

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.pdf) { state.scale = fitScale(); renderAll(); } }, 250);
});

const src = new URLSearchParams(location.search).get("src");
if (src) openFromUrl(src);

// Exposed for automated tests only.
globalThis.__firmalocal = { state, buildPdf };
