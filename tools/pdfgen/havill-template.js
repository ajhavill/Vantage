// Generates a Havill & Co.-branded proposal LETTERHEAD TEMPLATE (.docx) with Vantage
// merge tags already placed, then verifies it merges cleanly with docxtemplater.
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, AlignmentType, Header, Footer,
  Table, TableRow, TableCell, WidthType, BorderStyle
} = require("docx");

const OUT = path.join(__dirname, "..", "..", "Havill-Co-Proposal-Template.docx");
const NAVY = "1B2A4A", SOFT = "55606F", INK = "1A2230", LINE = "D2CCBF", ACCENT = "2D6E7E";
const SERIF = "Georgia", SANS = "Calibri";

function txt(text, o) { o = o || {}; return new TextRun(Object.assign({ text: text, font: o.font || SERIF, color: o.color || INK, size: o.size || 21 }, o)); }
function p(runs, o) { o = o || {}; return new Paragraph(Object.assign({ children: Array.isArray(runs) ? runs : [runs] }, o)); }
function noBorder() { var n = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }; return { top: n, bottom: n, left: n, right: n, insideHorizontal: n, insideVertical: n }; }

// --- letterhead (document header) ---
const header = new Header({
  children: [
    p(txt("HAVILL & CO.", { font: SANS, bold: true, size: 32, color: NAVY })),
    p(txt("COMMERCIAL REAL ESTATE   ·   TENANT REPRESENTATION", { font: SANS, size: 15, color: SOFT, characterSpacing: 12 }), { spacing: { after: 40 } }),
    p([], { border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: LINE, space: 1 } }, spacing: { after: 120 } }),
  ],
});

const footer = new Footer({
  children: [p(txt("Havill & Co.   ·   Santa Monica, California   ·   Confidential & Proprietary", { font: SANS, size: 14, color: SOFT }), { alignment: AlignmentType.CENTER })],
});

// --- terms table (label | {tag}) with light row separators ---
function termRow(label, value, last) {
  var sep = last ? { style: BorderStyle.NONE, size: 0, color: "FFFFFF" } : { style: BorderStyle.SINGLE, size: 4, color: "E2DDD2" };
  function cell(children, width) {
    return new TableCell({
      children: children, width: { size: width, type: WidthType.PERCENTAGE },
      borders: { top: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE }, bottom: sep },
      margins: { top: 60, bottom: 60, left: 0, right: 80 },
    });
  }
  return new TableRow({ children: [
    cell([p(txt(label, { font: SANS, size: 18, color: SOFT }))], 38),
    cell([p(value)], 62),
  ]});
}
const termsTable = new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  borders: noBorder(),
  rows: [
    termRow("Premises", [txt("{building}", { bold: true })]),
    termRow("Approximate Size", [txt("{size_sf} rentable square feet")]),
    termRow("Lease Term", [txt("{term_months} months ({term_years} years)")]),
    termRow("Rent Structure", [txt("{rent_structure}")]),
    termRow("Base Rent", [txt("{base_rent} "), txt("per RSF / year", { color: SOFT })]),
    termRow("Operating Expenses", [txt("{opex} "), txt("per RSF / year", { color: SOFT })]),
    termRow("Annual Escalation", [txt("{escalation}")]),
    termRow("Free Rent", [txt("{free_rent} months")]),
    termRow("Tenant Improvement Allowance", [txt("{ti} "), txt("per RSF", { color: SOFT })], true),
  ],
});

const doc = new Document({
  creator: "Havill & Co.",
  title: "Lease Proposal Template",
  sections: [{
    properties: { page: { margin: { top: 1100, bottom: 1000, left: 1300, right: 1300 } } },
    headers: { default: header },
    footers: { default: footer },
    children: [
      p(txt("{date}", { color: SOFT }), { alignment: AlignmentType.RIGHT, spacing: { after: 200 } }),
      p([txt("RE:  ", { font: SANS, bold: true, color: NAVY, size: 20 }), txt("Lease Proposal — {building}", { font: SANS, bold: true, color: NAVY, size: 20 })], { spacing: { after: 200 } }),
      p(txt("Dear {client},"), { spacing: { after: 160 } }),
      p(txt("On behalf of our client, we are pleased to present the following proposal for your consideration regarding {building}. We believe these terms represent a strong opportunity and look forward to your response."), { spacing: { after: 220 }, alignment: AlignmentType.JUSTIFIED }),
      p(txt("Summary of Proposed Terms", { font: SANS, bold: true, size: 22, color: NAVY }), { spacing: { after: 100 } }),
      termsTable,
      p([txt("Additional Notes:  ", { font: SANS, bold: true, color: SOFT, size: 18 }), txt("{notes}")], { spacing: { before: 200, after: 220 } }),
      p(txt("We are confident these terms provide an excellent fit and welcome the opportunity to discuss them further. Please do not hesitate to reach out with any questions."), { spacing: { after: 260 }, alignment: AlignmentType.JUSTIFIED }),
      p(txt("Sincerely,"), { spacing: { after: 360 } }),
      p(txt("{broker}", { bold: true }), { spacing: { after: 0 } }),
      p(txt("Havill & Co.", { color: SOFT })),
    ],
  }],
});

Packer.toBuffer(doc).then(function (buf) {
  fs.writeFileSync(OUT, buf);
  console.log("Wrote " + OUT + " (" + buf.length + " bytes)");

  // ---- verify it merges cleanly with the same engine the app uses ----
  try {
    const PizZip = require("pizzip");
    const Docxtemplater = require("docxtemplater");
    const zip = new PizZip(fs.readFileSync(OUT));
    const d = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
    d.render({
      date: "June 29, 2026", broker: "Andrew Havill", client: "Northpoint Analytics, Inc.",
      building: "The Water Garden", rent_structure: "FSG", base_rent: "$5.25", opex: "$12.00",
      gross_rent: "$17.25", size_sf: "9,500", term_months: "60", term_years: "5.0",
      escalation: "3.0%", free_rent: "4", ti: "$65.00", notes: "Landlord to deliver in turnkey condition.",
    });
    const out = d.getZip().file("word/document.xml").asText().replace(/<[^>]+>/g, "");
    const ok = ["Northpoint Analytics", "The Water Garden", "$5.25", "60 months", "Andrew Havill"].every(function (s) { return out.indexOf(s) > -1; });
    console.log("MERGE VERIFY: " + (ok ? "PASS — tags fill correctly" : "FAIL"));
    if (!ok) console.log(out.slice(0, 400));
  } catch (e) { console.log("MERGE VERIFY error: " + e.message); }
});
