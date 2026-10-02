import { Worker } from "worker_threads";
import sharp from "sharp";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createWorker } from "tesseract.js";
import { parsePage, buildRows, pageType } from "./parser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LANG_PATH = path.resolve(__dirname, "..", "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int");

const KEYWORDS = /proof|delivery|varun|beverages|vehicle|transporter|invoice|details|kairav|logistics|carrier|consign|doc\s*no|sr\.?\s*no/gi;
const DETECT_SCALE = 1.6; // low-res full-page pass: finds orientation and page type
const FINAL_SCALE = 3; // high-res pass, only run on the small region that needs it
const HEADER_FRACTION = 0.3; // top share of an upright Proof of Delivery page that holds company, address, Doc No
const DETECT_FRACTION = 0.55; // only the top of the upright page is read for detection; the page type and headings are all up there
const MIN_HITS_UPRIGHT = 5; // keyword hits that prove a render is upright (sideways text yields ~0)

// A slot is one OCR worker for full pages plus two lazily-started specialists (page segmentation mode is fixed
// per worker, never toggled, which keeps results stable). Several slots read pages in parallel, and the same
// pool is shared by every PDF being processed, so bulk uploads use all of them.
const SLOT_COUNT = Math.max(1, Math.min(Number(process.env.OCR_WORKERS) || 10, Math.floor(os.availableParallelism() / 2)));
const slots = [];
const idle = [];
const waiting = [];

const makeWorker = async (params) => {
  const w = await createWorker("eng", 1, { langPath: LANG_PATH, gzip: true, cacheMethod: "none" });
  if (params) await w.setParameters(params);
  return w;
};

async function createSlot() {
  const slot = { auto: await makeWorker() };
  slot.block = () => (slot._block ??= makeWorker({ tessedit_pageseg_mode: "6" }));
  slot.digits = () => (slot._digits ??= makeWorker({ tessedit_pageseg_mode: "6", tessedit_char_whitelist: "0123456789" }));
  return slot;
}

async function withSlot(job) {
  let slot = idle.pop();
  if (!slot && slots.length < SLOT_COUNT) {
    const pending = createSlot();
    slots.push(pending);
    slot = await pending;
  }
  slot ??= await new Promise((resolve) => waiting.push(resolve));
  try {
    return await job(slot);
  } finally {
    const next = waiting.shift();
    if (next) next(slot);
    else idle.push(slot);
  }
}

// PDF rendering (JPEG decode + scale) is the heaviest CPU step, so it runs in worker threads, one PDF per thread.
// Pages come back as raw RGB pixels (no PNG encoding); sharp then does the image work on its own threads.
const RENDERER_COUNT = Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 4)));
const renderers = [];
const inFlight = new Map(); // message id -> { resolve, reject, worker }
let messageId = 0;
let docId = 0;

function spawnRenderer(index) {
  const worker = new Worker(new URL("./render-worker.js", import.meta.url));
  worker.on("message", ({ id, error, ...result }) => {
    const call = inFlight.get(id);
    inFlight.delete(id);
    if (call) error ? call.reject(new Error(error)) : call.resolve(result);
  });
  worker.on("error", (err) => {
    for (const [id, call] of inFlight) if (call.worker === worker) { inFlight.delete(id); call.reject(err); }
    renderers[index] = spawnRenderer(index); // replace a crashed renderer
  });
  return worker;
}

const callRenderer = (worker, message, transfer = []) =>
  new Promise((resolve, reject) => {
    const id = ++messageId;
    inFlight.set(id, { resolve, reject, worker });
    worker.postMessage({ id, ...message }, transfer);
  });

function pickRenderer(id) {
  if (!renderers.length) for (let i = 0; i < RENDERER_COUNT; i++) renderers.push(spawnRenderer(i));
  return () => renderers[id % RENDERER_COUNT]; // looked up each call so a replaced renderer is picked up
}
const FAST_PNG = { compressionLevel: 1 }; // intermediate images only feed OCR, so favour speed over size

const keywordHits = (text) => (text.match(KEYWORDS) || []).length;
const wordsOf = (data) => (data.blocks || []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)));

// Scanned pages are often sideways. Pages of one batch are usually scanned the same way, so the last
// orientation that worked is tried first and the other three only run when it does not look upright.
// Returns the winning read too, so the low-res text is not computed twice.
let rotationHint = 270;
async function readUpright(worker, small) {
  const order = [rotationHint, ...[0, 270, 90, 180].filter((r) => r !== rotationHint)];
  let best = { score: -1 };
  for (const rotation of order) {
    // Rotate first, then crop (sharp applies extract before rotate inside one pipeline, so this takes two steps).
    const turned = await small.clone().rotate(rotation).raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = turned.info;
    const buf = await sharp(turned.data, { raw: { width, height, channels } })
      .extract({ left: 0, top: 0, width, height: Math.round(height * DETECT_FRACTION) })
      .withMetadata({ density: 300 })
      .png(FAST_PNG)
      .toBuffer();
    const { data } = await worker.recognize(buf, {}, { text: true, blocks: true });
    const hits = keywordHits(data.text);
    const score = hits * 100 + data.confidence;
    if (score > best.score) best = { score, rotation, text: data.text, words: wordsOf(data) };
    if (hits >= MIN_HITS_UPRIGHT) break;
  }
  rotationHint = best.rotation;
  return best;
}

const renderUpright = (full, rotation) => full.clone().rotate(rotation).grayscale().normalize().withMetadata({ density: 300 }).png(FAST_PNG).toBuffer();

// The Sr. No sits under the "INVOICE DETAILS" heading. Crop that cell and read digits only,
// which is far more reliable than a full-page read for a large, spaced-out number.
// Word boxes come from the low-res read, so they are scaled up to the high-res render.
async function readSrNo(slot, full, rotation, words) {
  const inv = words.find((w) => /^invoice$/i.test(w.text));
  const det = words.find((w) => /^details/i.test(w.text));
  if (!inv || !det) return "";
  const k = FINAL_SCALE / DETECT_SCALE;
  const img = await renderUpright(full, rotation);
  const { width, height } = await sharp(img).metadata();
  const x0 = Math.min(inv.bbox.x0, det.bbox.x0) * k;
  const x1 = Math.max(inv.bbox.x1, det.bbox.x1) * k;
  const top = Math.max(inv.bbox.y1, det.bbox.y1) * k;
  const headingHeight = (Math.max(inv.bbox.y1, det.bbox.y1) - Math.min(inv.bbox.y0, det.bbox.y0)) * k;
  const left = Math.max(0, Math.round(x0 - 20));
  const rect = {
    left,
    top: Math.min(Math.round(top), height - 2),
    width: Math.max(2, Math.min(width - left, Math.round(x1 - x0 + 60))),
    height: Math.max(2, Math.min(height - Math.round(top), Math.round(headingHeight * 3.6))),
  };
  const crop = await sharp(img).extract(rect).withMetadata({ density: 300 }).png(FAST_PNG).toBuffer();
  return (await (await slot.digits()).recognize(crop)).data.text;
}

// Proof of Delivery pages: only the header band is read at high resolution. It holds the company, address,
// Doc No, vehicle and date, and reading it alone keeps the address from mixing with the item table below.
async function readHeader(slot, full, rotation) {
  const img = await renderUpright(full, rotation);
  const { width, height } = await sharp(img).metadata();
  const band = await sharp(img).extract({ left: 0, top: 0, width, height: Math.round(height * HEADER_FRACTION) }).withMetadata({ density: 300 }).png(FAST_PNG).toBuffer();
  const { data } = await (await slot.block()).recognize(band, {}, { text: true, blocks: true });
  const lines = (data.blocks || [])
    .flatMap((b) => b.paragraphs.flatMap((p) => p.lines))
    .map((l) => l.words.map((w) => ({ t: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 })));
  return { text: data.text, lines, width };
}

async function readWholePage(worker, small, rotation) {
  const buf = await small.clone().rotate(rotation).withMetadata({ density: 300 }).png(FAST_PNG).toBuffer();
  return wordsOf((await worker.recognize(buf, {}, { text: true, blocks: true })).data);
}

async function readPage(slot, renderer, id, index) {
  // One render at full resolution; the low-res copy used for orientation/type detection is shrunk from it.
  const r = await callRenderer(renderer(), { op: "render", docId: id, pageIndex: index, scale: FINAL_SCALE });
  const layerText = r.text;
  const full = sharp(Buffer.from(r.raw), { raw: { width: r.width, height: r.height, channels: r.channels } });
  const shrunk = await full.clone().resize({ width: Math.round((r.width * DETECT_SCALE) / FINAL_SCALE) }).raw().toBuffer({ resolveWithObject: true });
  const small = sharp(shrunk.data, { raw: shrunk.info });

  const { rotation, text, words } = await readUpright(slot.auto, small);
  const type = pageType(`${text}
${layerText}`);
  const header = type === "pod" ? await readHeader(slot, full, rotation) : null;
  let srCrop = "";
  if (type === "invoice") {
    // The heading is usually found in the top-half read; if not, read the whole page once to locate it.
    const hasHeading = (ws) => ws.some((w) => /^invoice$/i.test(w.text)) && ws.some((w) => /^details/i.test(w.text));
    const headingWords = hasHeading(words) ? words : await readWholePage(slot.auto, small, rotation);
    srCrop = await readSrNo(slot, full, rotation, headingWords);
  }
  return { text, headerText: header?.text || "", headerLines: header?.lines, headerWidth: header?.width, layerText, srCrop, rotation };
}

export async function extractPdf(buffer, fileName) {
  const id = ++docId;
  const renderer = pickRenderer(id);
  const { pageCount } = await callRenderer(renderer(), { op: "open", docId: id, buffer });
  try {
    const pages = await Promise.all(
      Array.from({ length: pageCount }, (_, i) =>
        withSlot(async (slot) => {
          const read = await readPage(slot, renderer, id, i);
          return { page: i + 1, rotation: read.rotation, text: read.text, headerText: read.headerText, ...parsePage(read) };
        })
      )
    );
    return { file: fileName, pageCount: pages.length, pages, rows: buildRows(pages, fileName) };
  } finally {
    callRenderer(renderer(), { op: "close", docId: id }).catch(() => {});
  }
}

export async function shutdown() {
  for (const pending of slots) {
    const slot = await pending;
    const started = await Promise.all([slot._block, slot._digits].filter(Boolean));
    await Promise.all([slot.auto, ...started].map((w) => w.terminate()));
  }
  await Promise.all(renderers.map((w) => w.terminate()));
}
