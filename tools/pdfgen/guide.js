// Generates the Vantage Deal Flow — Broker Quick Guide (branded one-pager PDF).
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const OUT = path.join(__dirname, "..", "..", "Vantage-Deal-Flow-Broker-Guide.pdf");
const NAVY = "#1B2A4A", ACCENT = "#2D6E7E", INK = "#1A2230", SOFT = "#55606F", LINE = "#D2CCBF";

const doc = new PDFDocument({ size: "LETTER", margins: { top: 50, bottom: 48, left: 56, right: 56 },
  info: { Title: "Vantage Deal Flow — Broker Quick Guide", Author: "Havill & Co." } });
doc.pipe(fs.createWriteStream(OUT));

const L = doc.page.margins.left, R = doc.page.width - doc.page.margins.right, CW = R - L;
const BOTTOM = doc.page.height - doc.page.margins.bottom;
function ensure(h) { if (doc.y + h > BOTTOM) doc.addPage(); }

function rule() { doc.moveDown(0.35); doc.lineWidth(0.7).strokeColor(LINE).moveTo(L, doc.y).lineTo(R, doc.y).stroke(); doc.moveDown(0.5); }
function H(num, title) {
  ensure(30); doc.moveDown(0.5);
  var y = doc.y;
  doc.font("Helvetica-Bold").fontSize(11.5).fillColor(ACCENT).text(num + "  ", L, y, { continued: true });
  doc.fillColor(NAVY).text(title);
  doc.moveDown(0.2);
}
function body(t) {
  doc.font("Helvetica").fontSize(9.5).fillColor(INK);
  ensure(doc.heightOfString(t, { width: CW, lineGap: 1.5 }) + 3);
  doc.text(t, L, doc.y, { width: CW, lineGap: 1.5 });
}
function bullet(label, t) {
  doc.font("Helvetica").fontSize(9.5);
  var w = CW - 14;
  var full = (label ? "" : "") + t;
  var h = doc.heightOfString(t, { width: w, lineGap: 1.5 });
  ensure(h + 3);
  var y = doc.y;
  doc.circle(L + 3.5, y + 5.5, 1.7).fill(ACCENT);
  doc.fillColor(INK).font("Helvetica");
  if (label) {
    doc.text(label, L + 14, y, { width: w, continued: true, lineGap: 1.5 });
    // label part bold via a separate run is tricky inline; keep it simple — bold whole lead word done below
  }
  doc.font("Helvetica").fontSize(9.5).fillColor(INK).text(t, label ? undefined : L + 14, label ? undefined : y, { width: w, lineGap: 1.5 });
  doc.moveDown(0.1);
}
// simpler bullet with a bold lead label
function pt(label, t) {
  doc.font("Helvetica").fontSize(9.5);
  var w = CW - 14;
  var h = doc.heightOfString(label + " — " + t, { width: w, lineGap: 1.5 });
  ensure(h + 3);
  var y = doc.y;
  doc.circle(L + 3.5, y + 5.5, 1.7).fill(ACCENT);
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(NAVY).text(label, L + 14, y, { width: w, continued: true, lineGap: 1.5 });
  doc.font("Helvetica").fillColor(INK).text("  " + t, { width: w, lineGap: 1.5 });
  doc.moveDown(0.12);
}

// ---- letterhead ----
doc.font("Helvetica-Bold").fontSize(16).fillColor(NAVY).text("Vantage", L, 50, { continued: true });
doc.fillColor(ACCENT).text(".");
doc.font("Helvetica").fontSize(8).fillColor(SOFT).text("DEAL FLOW  —  BROKER QUICK GUIDE", L, 54, { width: CW, align: "right" });
doc.y = 74;
doc.font("Helvetica").fontSize(8.5).fillColor(SOFT).text("Havill & Co.", L, doc.y);
rule();

doc.font("Helvetica").fontSize(9.7).fillColor(INK).text(
  "Track every engagement from first tour to a signed lease, run side-by-side proposal analysis, draft proposals with AI, " +
  "and give each client a private, live portal of their search. Here's everything you need to get going.",
  L, doc.y, { width: CW, lineGap: 1.5 });

H("1", "Sign in");
pt("Go to havill-vantage.netlify.app", "and sign in with your Havill email.");
pt("Click “Deal flow” in the left sidebar.", "Same login runs the market Cockpit, so it's all one app.");

H("2", "The pipeline");
body("Your deals live in six stages:  Needs & Research  >  Touring  >  Evaluating Options  >  Proposals  >  Negotiation  >  Executed.");
pt("+ New deal", "starts one. Open any deal and use the Stage dropdown to move it along.");
pt("Closed / dead deals", "tuck into a collapsible list under the board — click one to reopen it.");

H("3", "Inside a deal");
pt("Buildings", "add the properties in play for the client.");
pt("Tour schedule", "add visits — building, date & time, status, notes.");
pt("Proposals & rounds", "add a proposal per building, then log each round (your offer or the landlord's counter) with the economics: rent structure, base rent, opex, escalations, free rent, TI, and term.");
pt("Compare", "shows every proposal side-by-side, normalized to one net-effective rent — so a full-service deal and an NNN deal compare apples-to-apples.");

H("4", "Draft proposals with AI");
pt("On a proposal, click Draft with AI.", "Pick a template (paste one, or upload your Word .docx).");
pt("Type — or tap the mic and talk — the deal points.", "Claude writes the proposal and fills in the numbers.");
pt("It appears as a draft round.", "Click “review” to read it, edit the wording and terms, then “Mark as final.”");

H("5", "Files & the lease abstract");
pt("Attach files", "(proposal PDFs, Word docs) to any proposal.");
pt("Lease abstract", "when the deal signs, fill in the executed lease's key terms — it auto-fills from your finalized proposal. This becomes your client's permanent reference (premises, term, rent, options, deposit, and critical dates).");

H("6", "Share with your client");
pt("Click “Share with client”", "set a passcode and you get a private link. Send the link and the passcode separately (text + email).");
pt("Control what they see", "with the Shown / Hidden toggles on proposals, files, tours, and the lease abstract. Drafts never show.");
pt("They get a clean, read-only portal", "(no login), can Download a PDF leave-behind, and you'll see “Client opened 3× · last 2h ago” right on the deal.");

rule();
doc.font("Helvetica-Bold").fontSize(9.5).fillColor(NAVY).text("A few good habits", L, doc.y);
doc.moveDown(0.15);
doc.font("Helvetica").fontSize(9.3).fillColor(INK).text(
  "•  Mark a proposal “Shown” only when it's ready.    •  Keep rounds current — the compare always reflects the latest.    " +
  "•  Review and finalize AI drafts before sharing.", L, doc.y, { width: CW, lineGap: 2 });

doc.moveDown(0.8);
doc.font("Helvetica-Oblique").fontSize(8.3).fillColor(SOFT).text(
  "Questions? Ask Andrew.    ·    havill-vantage.netlify.app", L, doc.y, { width: CW, align: "center" });

doc.end();
process.on("exit", () => console.log("Wrote " + OUT));
