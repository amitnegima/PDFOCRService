import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import ExcelJS from "exceljs";
import { extractPdf, shutdown } from "./extractor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Limits that keep the server from choking. All can be overridden with environment variables.
const MAX_FILES_PER_REQUEST = Number(process.env.MAX_FILES_PER_REQUEST) || 20; // PDFs accepted in one API call
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB) || 50; // size of a single PDF
const MAX_CONCURRENT_BATCHES = Number(process.env.MAX_CONCURRENT_BATCHES) || 4; // API calls being processed at once

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_FILES_PER_REQUEST },
});

// Lets the page work even when its HTML is opened from another origin (e.g. VS Code Live Server on :5500).
app.use("/api", (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));
// The browser unzips uploaded .zip files itself, using the JSZip copy that ships with exceljs.
app.get("/vendor/jszip.min.js", (req, res) => res.sendFile(path.join(__dirname, "..", "node_modules", "jszip", "dist", "jszip.min.js")));

// The page reads these so its settings can never ask for more than the server accepts.
app.get("/api/config", (req, res) => res.json({ maxFilesPerRequest: MAX_FILES_PER_REQUEST, maxFileMb: MAX_FILE_MB }));

// At most MAX_CONCURRENT_BATCHES batches are processed at once; further ones wait their turn.
let active = 0;
const waiting = [];
const acquire = () => (active < MAX_CONCURRENT_BATCHES ? (active++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
const release = () => (waiting.length ? waiting.shift()() : active--);

app.post("/api/extract", upload.array("pdfs", MAX_FILES_PER_REQUEST), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "No PDFs uploaded (field name: pdfs)" });

  await acquire();
  try {
    // One bad PDF must not fail the batch, so every file reports its own result or error.
    const results = await Promise.all(
      files.map(async (f) => {
        const name = Buffer.from(f.originalname, "latin1").toString("utf8");
        if (f.mimetype !== "application/pdf" && !/.pdf$/i.test(name)) return { file: name, error: "Not a PDF file" };
        try {
          const { rows, pageCount } = await extractPdf(f.buffer, name);
          return { file: name, pageCount, rows };
        } catch (err) {
          console.error(`Failed on ${name}:`, err);
          return { file: name, error: `Could not read this PDF: ${err.message}` };
        }
      })
    );
    res.json({ results });
  } finally {
    release();
  }
});

// Upload-limit violations from multer come back as clear JSON instead of an HTML error page.
app.use((err, req, res, next) => {
  if (!(err instanceof multer.MulterError)) return next(err);
  const message =
    err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE"
      ? `Too many PDFs in one request (limit ${MAX_FILES_PER_REQUEST})`
      : err.code === "LIMIT_FILE_SIZE"
        ? `A PDF is larger than ${MAX_FILE_MB} MB`
        : err.message;
  res.status(413).json({ error: message });
});

// Builds the upload workbook. Column names and order match the sheet the data is loaded into.
const toNumber = (v) => (/^\d+$/.test(String(v ?? "").trim()) ? Number(v) : v ?? "");
const toDate = (v) => {
  const m = String(v ?? "").match(/^(\d{2})[.\-/](\d{2})[.\-/](\d{4})$/);
  return m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])) : v ?? "";
};

app.post("/api/export", async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.columns = [
    { header: "Lrno", key: "lr", width: 12 },
    { header: "DELIVERYNO", key: "deliveryNo", width: 16 },
    { header: "TotalQty", key: "totalQty", width: 12 },
    { header: "LOCATION", key: "location", width: 18 },
    { header: "Vehicle no", key: "vehicle", width: 18 },
    { header: "Invoicedate", key: "date", width: 14, style: { numFmt: "dd-mm-yy" } },
  ];
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    ws.addRow({
      lr: toNumber(r.lr),
      deliveryNo: toNumber(r.deliveryNo),
      totalQty: toNumber(r.totalQty ?? 0),
      location: r.location ?? "",
      vehicle: r.vehicle ?? "",
      date: toDate(r.date),
    });
  }
  res.set({
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": 'attachment; filename="pdf-extract.xlsx"',
  });
  await wb.xlsx.write(res);
  res.end();
});

const server = app.listen(PORT, () => console.log(`PDF Reader OCR running at http://localhost:${PORT}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    await shutdown();
    process.exit(0);
  });
}
