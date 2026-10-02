// Runs in a worker thread: opens PDFs and renders pages to raw RGB pixels.
// Decoding and scaling the scanned JPEGs inside a PDF is CPU heavy, so it must not happen on the main thread,
// where it would stall the HTTP server and leave the OCR workers waiting for pages.
import { parentPort } from "worker_threads";
import * as mupdf from "mupdf";

const docs = new Map();

parentPort.on("message", ({ id, op, docId, buffer, pageIndex, scale }) => {
  try {
    if (op === "open") {
      const doc = mupdf.Document.openDocument(buffer, "application/pdf");
      docs.set(docId, doc);
      parentPort.postMessage({ id, pageCount: doc.countPages() });
    } else if (op === "render") {
      const page = docs.get(docId).loadPage(pageIndex);
      const text = page.toStructuredText().asText();
      const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
      const width = pix.getWidth();
      const raw = new Uint8Array(pix.getPixels()).buffer; // copy out of WASM memory so it can be transferred
      parentPort.postMessage({ id, raw, width, height: pix.getHeight(), channels: pix.getStride() / width, text }, [raw]);
    } else if (op === "close") {
      const doc = docs.get(docId);
      docs.delete(docId);
      doc?.destroy?.();
      parentPort.postMessage({ id });
    }
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
