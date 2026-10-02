// Turns noisy OCR text into the five output columns.
// Every field is gathered from several sources (header-band OCR, full-page OCR, the PDF's own text layer)
// and across all pages of one PDF, then settled by weighted vote so single OCR slips get outvoted.

const DIGIT_LOOKALIKE = { O: "0", o: "0", B: "8", S: "5", I: "1", l: "1", "|": "1", Z: "2", G: "6", T: "7" };
const LETTER_LOOKALIKE = { 0: "O", 1: "I", 5: "S", 8: "B", 6: "G", 2: "Z", 7: "T" };

const toDigits = (s) => [...s].map((c) => DIGIT_LOOKALIKE[c] ?? c).join("");
const toLetters = (s) => [...s].map((c) => LETTER_LOOKALIKE[c] ?? c).join("");
const lines = (t) => (t || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

function vote(candidates) {
  const tally = new Map();
  for (const { value, weight } of candidates) tally.set(value, (tally.get(value) || 0) + weight);
  return [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([value, score]) => ({ value, score }));
}

// ---------- page type ----------

export function pageType(text) {
  // Any one strong signal is enough, since a low-res read often garbles part of the title.
  if (/\bvarun\b|beverages?\s*limited|proof\s*of\s*deliv|transporter\s*copy|doc\s*no\.?\s*\d{9}/i.test(text)) return "pod";
  if (/invoice\s*details|lorry\s*receipt|carrier'?s\s*risk|kairav/i.test(text)) return "invoice";
  return "other";
}

// ---------- 2) Delivery no: Doc No, nine digits ----------

function docNoCandidates(sources) {
  const found = [];
  for (const text of sources) {
    for (const m of text.matchAll(/Doc\s*No\.?\s*[:.]?\s*([0-9OBIlS]{9})(?![0-9])/gi)) {
      found.push({ value: toDigits(m[1]), weight: 5 });
    }
    // The same number is printed at the start of every item row: "894172852 / 44284727 / RV0007231042".
    for (const m of text.matchAll(/(?<![0-9A-Za-z])([0-9OBIlS]{9})\s*[/|Il1]?\s*\d{8}(?![0-9])/g)) {
      found.push({ value: toDigits(m[1]), weight: 1 });
    }
  }
  return found.filter((c) => /^\d{9}$/.test(c.value));
}

// ---------- 4) Vehicle Reg. No ----------

// Indian plate: 2 letters, 2 digits, 1-3 letters, 4 digits. Fix look-alike characters by position.
function normalisePlate(raw) {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const seriesLen of [1, 2, 3]) {
    if (s.length !== 8 + seriesLen) continue;
    const plate =
      toLetters(s.slice(0, 2)) + toDigits(s.slice(2, 4)) + toLetters(s.slice(4, 4 + seriesLen)) + toDigits(s.slice(4 + seriesLen));
    if (/^[A-Z]{2}\d{2}[A-Z]{1,3}\d{4}$/.test(plate)) return plate;
  }
  return null;
}

function vehicleCandidates(sources) {
  const found = [];
  for (const text of sources) {
    for (const m of text.matchAll(/Vehi\w*\s*R\w*\.?\s*No\.?\s*[:.©]?\s*([A-Za-z0-9 ]{8,14}?)\s*(?:\/|\||$|\d{1,2}\s*T\b)/gim)) {
      const plate = normalisePlate(m[1]);
      if (plate) found.push({ value: plate, weight: 3 });
    }
    for (const m of text.matchAll(/\b([A-Z]{2}\s?\d{2}\s?[A-Z]{1,3}\s?\d{4})\b/g)) {
      const plate = normalisePlate(m[1]);
      if (plate) found.push({ value: plate, weight: 1 });
    }
  }
  return found;
}

// ---------- 5) Date ----------

function dateCandidates(headerText) {
  const found = [];
  const all = lines(headerText);
  all.forEach((line, i) => {
    for (const m of line.matchAll(/(?<!\d)(\d{2})[.\-/](\d{2})[.\-/](\d{4})(?!\d)/g)) {
      const [d, mo, y] = [+m[1], +m[2], +m[3]];
      if (d < 1 || d > 31 || mo < 1 || mo > 12 || y < 2000 || y > 2100) continue;
      const nearLabel = /date/i.test(line) || /date/i.test(all[i - 1] || "") || /date/i.test(all[i + 1] || "");
      found.push({ value: `${m[1]}.${m[2]}.${m[3]}`, weight: nearLabel ? 3 : 1 });
    }
  });
  return found;
}

// ---------- 3) Address: the lines between the company name and "Pin:" ----------

// Where an address ends: the Pin line, phone/email, any long number (item codes) or the table's "Checked" column.
const ADDRESS_STOP = /\bpin\s*[:\-]|\bphone\b|\bemail\b|\bdist[.:]|\bchecked\b|\d{6,}/i;

function cleanAddress(s) {
  return s
    .replace(/Doc\s*No\.?\s*[:.]?\s*\d*/gi, " ")
    .split(ADDRESS_STOP)[0]
    .replace(/Rec\/?\s*Transporter\s*Copy/gi, " ")
    .replace(/[#@»«§~|©¢]+/g, " ")
    .replace(/(^|\s)[/\-–]\s/g, " ")
    .replace(/\bv[ae]?run\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.\-]+|[\s,]+$/g, "")
    .trim()
    .replace(/^plot\s*no/i, "Plot No");
}

function extractAddress(block) {
  const ls = lines(block);
  let start = ls.findIndex((l) => /plot\s*no/i.test(l));
  let first = "";
  if (start >= 0) {
    first = ls[start].slice(ls[start].search(/plot\s*no/i));
  } else {
    const company = ls.findIndex((l) => /beverages?\s*limited|limited$/i.test(l));
    if (company < 0) return null;
    start = company + 1;
    first = ls[start] ?? "";
  }
  const parts = [first];
  for (let i = start + 1; i < ls.length && i < start + 5; i++) {
    if (/pin\s*[:\-]|^\W*pin\b/i.test(ls[i])) break;
    parts.push(ls[i]);
  }
  const cut = parts.join(" ").split(/\bpin\s*[:\-]/i)[0];
  const address = cleanAddress(cut);
  return address.length >= 25 ? address : null;
}

// Geometry-based read: anchor on the word "Plot" and keep only words at or right of it, so text from the
// consignor box printed to the left of the address cannot leak in. Stops at the "Pin:" line.
// \`lines\` is [[{t, x0, y0, x1, y1}]] from the header-band OCR; \`width\` is that band's pixel width.
function addressFromLines(lines, width) {
  const rows = lines.map((ws) => [...ws].sort((a, b) => a.x0 - b.x0));
  let li = -1;
  let plot = null;
  for (let i = 0; i < rows.length && !plot; i++) {
    plot = rows[i].find((w, j) => /^plot$/i.test(w.t.replace(/\W/g, "")) && /^no/i.test(rows[i][j + 1]?.t || ""));
    if (plot) li = i;
  }
  if (!plot) return null;
  const xmin = plot.x0 - 0.04 * width;
  const parts = [];
  for (let i = li; i < rows.length && i < li + 5; i++) {
    const row = rows[i];
    if (i > li && /pin\s*[:\-]/i.test(row.map((w) => w.t).join(" "))) break;
    parts.push(row.filter((w) => w.x0 >= (i === li ? plot.x0 - 10 : xmin)).map((w) => w.t).join(" "));
  }
  const address = cleanAddress(parts.join(" "));
  return address.length >= 15 ? address : null;
}

const bigrams = (s) => {
  const t = s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const set = new Map();
  for (let i = 0; i < t.length - 1; i++) set.set(t.slice(i, i + 2), (set.get(t.slice(i, i + 2)) || 0) + 1);
  return set;
};
function similarity(a, b) {
  const [x, y] = [bigrams(a), bigrams(b)];
  let overlap = 0;
  for (const [k, n] of x) overlap += Math.min(n, y.get(k) || 0);
  const total = [...x.values(), ...y.values()].reduce((p, q) => p + q, 0);
  return total ? (2 * overlap) / total : 0;
}

// Well-formed tokens are real words or plot codes ("B-65", "B69pt"); stray fragments are OCR damage.
function addressQuality(address) {
  let score = 0;
  for (const tok of address.split(" ")) {
    if (/^[A-Za-z]{3,}[,.]?$/.test(tok) || /^[A-Za-z]{1,2}[-.]?\d{1,3}(pt)?,?$/i.test(tok) || /^(to|no\.?|of|and)$/i.test(tok)) score += 1;
    else score -= 2;
  }
  return score;
}

// Share of tokens that look like real words or plot codes (0..1).
function cleanliness(address) {
  const toks = address.split(" ");
  const good = toks.filter((t) => /^[A-Za-z]{3,}[,.]?$/.test(t) || /^[A-Za-z]{1,2}[-.]?d{1,3}(pt)?,?$/i.test(t) || /^(to|no.?|of|and)$/i.test(t));
  return good.length / toks.length;
}

// candidates: [{ a: address, bonus }]. Geometry-anchored reads carry a bonus; agreement between sources adds more.
function bestAddress(candidates) {
  const unique = [...new Set(candidates.map((c) => c.a))];
  if (!unique.length) return "";
  const scored = unique.map((a) => {
    const others = candidates.filter((c) => c.a !== a);
    const agreement = others.length ? others.reduce((n, o) => n + similarity(a, o.a), 0) / others.length : 0;
    const bonus = Math.max(...candidates.filter((c) => c.a === a).map((c) => c.bonus || 0));
    return { a, score: addressQuality(a) + 8 * agreement + bonus };
  });
  return scored.sort((x, y) => y.score - x.score)[0].a;
}

// ---------- LOCATION: the last word of the address (the town) ----------

const lastWord = (address) => (address.match(/([A-Za-z]{4,})[^A-Za-z]*$/) || [])[1] || "";
// Same word if the first five letters agree: covers cut-off and slightly garbled reads ("Tirunevel").
const sameWord = (a, b) => a.length >= 5 && b.length >= 5 && a.slice(0, 5).toLowerCase() === b.slice(0, 5).toLowerCase();
const titleCase = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

// The town is the same wherever it is printed, so it is settled by vote over every address read from every
// page and source of the PDF. A cut-off read ("Tirunevel") counts towards the full word it is the start of.
function bestLocation(addresses) {
  const counts = new Map();
  // Garbled reads end in garbage words, so only clean-looking addresses get a vote.
  const clean = addresses.filter((a) => cleanliness(a) >= 0.9);
  for (const a of clean.length ? clean : addresses) {
    const w = lastWord(a);
    if (w) counts.set(titleCase(w), (counts.get(titleCase(w)) || 0) + 1);
  }
  const words = [...counts.keys()];
  const scored = words.map((w) => {
    let score = counts.get(w);
    for (const other of words) if (other !== w && sameWord(w, other)) score += counts.get(other);
    return { w, score };
  });
  return scored.sort((a, b) => b.score - a.score || b.w.length - a.w.length)[0]?.w || "";
}

// ---------- 1) LR: Sr. No in Invoice Details ----------

function srNoFrom(text) {
  const near = text.match(/Sr\.?\s*No\.?[^\d\n]{0,25}((?:\d\s?){3,8})(?!\d)/i);
  if (near) return near[1].replace(/\s/g, "");
  return null;
}

// ---------- public API ----------

export function parsePage({ text, headerText, layerText, srCrop, headerLines, headerWidth }) {
  const type = pageType(`${text}\n${layerText || ""}`);
  const sources = [headerText, text, layerText].filter(Boolean);
  const fromGeometry = type === "pod" && headerLines ? addressFromLines(headerLines, headerWidth) : null;
  const addresses =
    type === "pod"
      ? [fromGeometry && { a: fromGeometry, bonus: 3 }, ...sources.map((s) => ({ a: extractAddress(s) }))].filter((c) => c && c.a)
      : [];
  // Sr. No is the first digit run in the crop (a handwritten date may follow it); any length from 3 to 8 digits.
  const srDigits = (srCrop || "").split(/\r?\n/).map((l) => l.replace(/\D/g, "")).find((d) => d.length >= 3 && d.length <= 8) || "";
  return {
    type,
    sr: srDigits ? { value: srDigits, source: "crop" } : srNoFrom(text) ? { value: srNoFrom(text), source: "text" } : null,
    docNos: type === "pod" ? docNoCandidates(sources) : [],
    vehicles: type === "pod" ? vehicleCandidates(sources) : [],
    dates: type === "pod" ? dateCandidates(headerText || text) : [],
    addresses,
  };
}

export function buildRows(pages, fileName) {
  const warnings = [];

  const srPage = pages.find((p) => p.type === "invoice" && p.sr) || pages.find((p) => p.sr);
  const fromName = (fileName.match(/(?<!\d)(\d{3,8})(?!\d)/) || [])[1];
  const lr = srPage?.sr?.value || fromName || "";
  if (!srPage) warnings.push(fromName ? "Sr. No not read from the page; taken from the file name" : "Sr. No not found");

  const pod = pages.filter((p) => p.type === "pod");
  if (!pod.length) {
    warnings.push("No Proof of Delivery page found");
    return [{ file: fileName, lr, deliveryNo: "", address: "", location: "", vehicle: "", date: "", pages: [], warnings }];
  }

  // One truck and one dispatch date per LR, so these are settled across every page of the PDF.
  const vehicle = vote(pod.flatMap((p) => p.vehicles))[0];
  const date = vote(pod.flatMap((p) => p.dates))[0];
  if (!vehicle) warnings.push("Vehicle Reg. No not found");
  if (!date) warnings.push("Date not found");

  // A delivery (Doc No) can span several pages, so pages are grouped by it.
  const groups = new Map();
  for (const p of pod) {
    const doc = vote(p.docNos)[0]?.value || "";
    if (!groups.has(doc)) groups.set(doc, []);
    groups.get(doc).push(p);
  }

  const location = bestLocation(pod.flatMap((x) => x.addresses).map((c) => c.a));
  if (!location) warnings.push("Location not found");

  const rows = [];
  for (const [deliveryNo, group] of groups) {
    const rowWarnings = [...warnings];
    if (!deliveryNo) rowWarnings.push("Doc No not found");
    let address = bestAddress(group.flatMap((p) => p.addresses));
    // Repair a cut-off final word ("Tirunevel") using the voted location.
    const tail = lastWord(address);
    if (tail && location && tail !== location && sameWord(tail, location)) {
      address = address.replace(new RegExp(tail + "[^A-Za-z]*$"), location);
    }
    if (!address) rowWarnings.push("Address not found");
    rows.push({
      file: fileName,
      lr,
      deliveryNo,
      address,
      location,
      vehicle: vehicle?.value || "",
      date: date?.value || "",
      pages: group.map((p) => p.page),
      warnings: rowWarnings,
    });
  }
  return rows;
}
