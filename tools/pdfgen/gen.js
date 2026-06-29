// Generates a detailed, ILLUSTRATIVE office-lease proposal (LOI) PDF to test the
// Vantage deal-flow document upload. All parties/figures are fictitious sample data.
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const OUT = path.join(__dirname, "..", "..", "Sample-Office-Lease-Proposal.pdf");
const NAVY = "#1B2A4A", ACCENT = "#2D6E7E", INK = "#1A2230", SOFT = "#55606F", LINE = "#D2CCBF", PAPER2 = "#FCFBF8";

const doc = new PDFDocument({ size: "LETTER", margins: { top: 50, bottom: 50, left: 54, right: 54 },
  info: { Title: "Proposal to Lease - The Water Garden, Suite 350", Author: "Meridian West Commercial (sample)" } });
doc.pipe(fs.createWriteStream(OUT));

const L = doc.page.margins.left;
const R = doc.page.width - doc.page.margins.right;
const CW = R - L;                       // content width
const BOTTOM = doc.page.height - doc.page.margins.bottom;

function ensure(h) { if (doc.y + h > BOTTOM) doc.addPage(); }

function heading(txt) {
  ensure(34);
  doc.moveDown(0.5);
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor(NAVY).text(txt, L, doc.y);
  doc.moveDown(0.25);
}
function body(txt) {
  doc.font("Helvetica").fontSize(9.4).fillColor(INK);
  ensure(doc.heightOfString(txt, { width: CW, align: "justify", lineGap: 1.5 }) + 4);
  doc.text(txt, L, doc.y, { width: CW, align: "justify", lineGap: 1.5 });
}
function bullet(txt) {
  doc.font("Helvetica").fontSize(9.4).fillColor(INK);
  const w = CW - 16;
  const h = doc.heightOfString(txt, { width: w, lineGap: 1.5 });
  ensure(h + 4);
  const y = doc.y;
  doc.circle(L + 4, y + 5.5, 1.6).fill(ACCENT);
  doc.fillColor(INK).text(txt, L + 16, y, { width: w, lineGap: 1.5 });
  doc.moveDown(0.15);
}

// Simple table: header row (navy) + body rows (alternating). cols = [{w, align}]
function table(headers, rows, cols) {
  const rowH = 18, headH = 20;
  ensure(headH + rowH * rows.length + 6);
  const startY = doc.y + 2;
  let y = startY;
  // header
  doc.rect(L, y, CW, headH).fill(NAVY);
  let x = L;
  doc.font("Helvetica-Bold").fontSize(8.4).fillColor("#FFFFFF");
  headers.forEach((h, i) => {
    doc.text(h, x + 6, y + 6, { width: cols[i].w - 12, align: cols[i].align || "left" });
    x += cols[i].w;
  });
  y += headH;
  // rows
  rows.forEach((row, ri) => {
    doc.rect(L, y, CW, rowH).fill(ri % 2 ? PAPER2 : "#FFFFFF");
    x = L;
    doc.font("Helvetica").fontSize(8.4).fillColor(INK);
    row.forEach((cell, i) => {
      doc.fillColor(INK).text(cell, x + 6, y + 5, { width: cols[i].w - 12, align: cols[i].align || "left" });
      x += cols[i].w;
    });
    y += rowH;
  });
  // borders
  doc.lineWidth(0.6).strokeColor(LINE).rect(L, startY, CW, headH + rowH * rows.length).stroke();
  doc.y = startY + headH + rowH * rows.length + 8;
}

// Two-column "label : value" box (parties / meta)
function defBox(pairs) {
  const labW = 120, valW = CW - labW, rowH = 18;
  ensure(rowH * pairs.length + 6);
  const startY = doc.y + 2;
  let y = startY;
  doc.rect(L, startY, CW, rowH * pairs.length).fill(PAPER2);
  pairs.forEach((p, i) => {
    doc.font("Helvetica-Bold").fontSize(8.6).fillColor(INK).text(p[0], L + 7, y + 5, { width: labW - 12 });
    doc.font("Helvetica").fontSize(8.6).fillColor(INK).text(p[1], L + labW, y + 5, { width: valW - 10 });
    if (i) { doc.lineWidth(0.4).strokeColor(LINE).moveTo(L, y).lineTo(R, y).stroke(); }
    y += rowH;
  });
  doc.lineWidth(0.6).strokeColor(LINE).rect(L, startY, CW, rowH * pairs.length).stroke();
  doc.y = startY + rowH * pairs.length + 8;
}

function hr() { doc.moveDown(0.3); doc.lineWidth(0.7).strokeColor(LINE).moveTo(L, doc.y).lineTo(R, doc.y).stroke(); doc.moveDown(0.4); }

// ---------------- letterhead ----------------
doc.font("Helvetica-Bold").fontSize(13).fillColor(NAVY).text("MERIDIAN WEST", L, 50);
doc.font("Helvetica").fontSize(7.5).fillColor(SOFT).text("COMMERCIAL REAL ESTATE  •  LANDLORD REPRESENTATION", L, doc.y);
doc.font("Helvetica").fontSize(7.5).fillColor(SOFT)
  .text("1801 Century Park East, Suite 1400\nLos Angeles, CA 90067  •  (310) 555-0142  •  Lic. 01998877",
        L, 52, { width: CW, align: "right" });
doc.y = 92; hr();

// title
doc.font("Helvetica-Bold").fontSize(15).fillColor(NAVY).text("PROPOSAL TO LEASE", L, doc.y, { width: CW, align: "center" });
doc.font("Helvetica").fontSize(9).fillColor(SOFT).text("Non-Binding Letter of Intent — Office Space", L, doc.y + 2, { width: CW, align: "center" });
doc.moveDown(0.8);

defBox([
  ["Date", "June 29, 2026                    Proposal No.  MW-2026-0488"],
  ["Property", "The Water Garden — 2425 Olympic Blvd, Santa Monica, CA 90404"],
  ["Premises", "Suite 350, 3rd Floor, West Tower"],
]);

body("On behalf of the Landlord, Meridian West Commercial is pleased to present the following non-binding proposal "
  + "for your client's consideration. This Letter of Intent outlines the principal business terms under which the "
  + "Landlord would be prepared to lease the above-referenced premises. It is intended solely as a basis for further "
  + "negotiation and creates no legal obligation on either party until a mutually executed lease is delivered.");

heading("1.  Parties");
defBox([
  ["Landlord", "WG Olympic Owner, LLC, a Delaware limited liability company"],
  ["Landlord's Broker", "Meridian West Commercial (Daniel Reyes, lic. 01998877)"],
  ["Tenant", "Northpoint Analytics, Inc., a California corporation"],
  ["Tenant's Broker", "Havill & Co. (procuring cause; commission per separate agreement)"],
]);

heading("2.  Premises");
body("Suite 350, located on the third (3rd) floor of the West Tower, comprising approximately 12,480 rentable square "
  + "feet (10,857 usable square feet; load factor 15.0%). The premises shall be delivered in their current "
  + "second-generation condition, broom-clean, with all building systems in good working order. The premises feature "
  + "operable skylights, exposed-ceiling creative improvements, two existing conference rooms, a private restroom, and "
  + "a plumbed kitchen / break area.");

heading("3.  Lease Term & Commencement");
body("Eighty-four (84) months (seven years). The estimated Commencement Date is October 1, 2026, with an Expiration "
  + "Date of September 30, 2033. Tenant shall be granted early access up to thirty (30) days prior to the Commencement "
  + "Date for installation of furniture, fixtures, cabling, and equipment, rent-free, subject to a certificate of "
  + "insurance and coordination with the Landlord's contractor.");

heading("4.  Base Rent (Full-Service Gross)");
body("Base Rent is quoted on a Full-Service Gross basis at an initial rate of $5.95 per rentable square foot, per "
  + "month ($71.40/RSF/year), increasing three percent (3.0%) on each annual anniversary of the Commencement Date, "
  + "per the schedule below:");

const RSF = 12480;
let rate = 5.95;
const rentRows = [];
for (let yr = 1; yr <= 7; yr++) {
  const monthly = rate * RSF, annual = monthly * 12, annualPsf = rate * 12;
  rentRows.push([`Year ${yr}`, `$${rate.toFixed(2)}`, `$${annualPsf.toFixed(2)}`,
    `$${monthly.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    `$${annual.toLocaleString("en-US", { maximumFractionDigits: 0 })}`]);
  rate = Math.round(rate * 1.03 * 100) / 100;
}
table(["Lease Year", "$/RSF/mo", "$/RSF/yr", "Monthly Base Rent", "Annual Base Rent"], rentRows,
  [{ w: 80 }, { w: 80, align: "right" }, { w: 80, align: "right" }, { w: 132, align: "right" }, { w: CW - 372, align: "right" }]);

heading("5.  Operating Expenses & Taxes");
body("Full-Service Gross with a Base Year of 2026. Tenant shall pay its pro-rata share (approximately 4.18%) of "
  + "increases in Operating Expenses and Real Property Taxes over the Base Year amount. Controllable operating "
  + "expenses shall not increase by more than five percent (5%) per year on a cumulative, compounding basis. "
  + "Operating expenses are currently estimated at $13.80/RSF/year.");

heading("6.  Rent Abatement");
body("Provided Tenant is not in default, Base Rent shall be abated in full for the first four (4) months of the Term "
  + "(Months 1–4). Tenant remains responsible for parking charges and after-hours HVAC, if any, during the abatement "
  + "period.");

heading("7.  Tenant Improvement Allowance");
body("Landlord shall provide a Tenant Improvement Allowance of $65.00 per rentable square foot (approximately "
  + "$811,200 in the aggregate) toward the design, permitting, and construction of Tenant's improvements. Any unused "
  + "portion remaining twelve (12) months after the Commencement Date may be applied, up to $10.00/RSF, as a credit "
  + "against Base Rent. The Allowance excludes Landlord's 2.5% construction-management fee.");

heading("8.  Parking");
body("Tenant shall have the right to 3.0 parking permits per 1,000 RSF (37 permits total) in the subterranean garage. "
  + "Initial rates: $165 per unreserved permit / month and $250 per reserved permit / month, subject to market "
  + "adjustment. Up to four (4) permits may be converted to reserved at Tenant's election. Rates are abated 50% during "
  + "the four-month abatement period.");

heading("9.  Security Deposit");
body("A Security Deposit equal to $75,000 (approximately one month of fully-escalated Base Rent) shall be due upon "
  + "lease execution. Subject to Tenant maintaining no monetary defaults, the deposit shall burn down by one-third at "
  + "the end of Months 24 and 48, with the balance refundable at expiration.");

heading("10.  Options & Rights");
bullet("Renewal Option: One (1) option to renew for five (5) years at ninety-five percent (95%) of the prevailing "
  + "Fair Market Rental Rate, on twelve (12) months' prior written notice.");
bullet("Right of First Offer: Ongoing ROFO on contiguous Suite 360 (approx. 4,300 RSF) should it become available "
  + "during the Term.");
bullet("Termination Option: One-time right to terminate effective at the end of Month 60 upon nine (9) months' notice "
  + "and payment of a termination fee equal to the unamortized Transaction Costs (TI, abatement, and commissions) at "
  + "8% interest.");
bullet("Building Signage: Tenant shall receive lobby-directory and suite-entry signage; eyebrow signage subject to "
  + "Landlord and City approval.");

heading("11.  Additional Terms");
body("Use: General office and ancillary uses consistent with a first-class office building. Building Hours: "
  + "7:00 a.m.–7:00 p.m. weekdays and 8:00 a.m.–1:00 p.m. Saturdays; after-hours HVAC at $55/hour per zone. "
  + "Assignment / Subletting: Permitted with Landlord's consent, not to be unreasonably withheld, with Permitted "
  + "Transfers to affiliates and successors without consent. Condition: Landlord warrants that building systems, roof, "
  + "and existing restrooms will be in good working order and ADA-compliant as of delivery. Contingencies: This "
  + "proposal is subject to Landlord's receipt and approval of Tenant's current financial statements and to mutual "
  + "approval of a definitive lease on the Landlord's standard form, as modified by negotiation.");

heading("12.  Acceptance & Expiration");
body("This proposal shall remain open for acceptance for ten (10) business days from the date hereof, after which it "
  + "shall expire unless extended in writing by the Landlord. This Letter of Intent is non-binding and is intended "
  + "only to facilitate negotiation; neither party shall be bound until a definitive lease is fully executed and "
  + "delivered.");

ensure(90);
doc.moveDown(1);
const sigY = doc.y;
doc.font("Helvetica").fontSize(8.6).fillColor(INK).text("Respectfully submitted,", L, sigY);
doc.text("Acknowledged & received:", L + CW / 2, sigY);
doc.font("Helvetica").fontSize(8.6).fillColor(INK)
  .text("______________________________\nDaniel Reyes", L, sigY + 34)
  .font("Helvetica").fontSize(7.5).fillColor(SOFT).text("Meridian West Commercial\nFor and on behalf of the Landlord", L, doc.y);
doc.font("Helvetica").fontSize(8.6).fillColor(INK)
  .text("______________________________\nNorthpoint Analytics, Inc.", L + CW / 2, sigY + 34)
  .font("Helvetica").fontSize(7.5).fillColor(SOFT).text("By: _______________   Date: __________", L + CW / 2, doc.y);

doc.moveDown(1.2); hr();
doc.font("Helvetica-Oblique").fontSize(7.4).fillColor(SOFT).text(
  "ILLUSTRATIVE SAMPLE — This document and all parties, figures, and terms herein are fictitious and were generated "
  + "solely to test the Vantage deal-flow document workflow. It is not an offer and references no real transaction.",
  L, doc.y, { width: CW, align: "left" });

doc.end();
doc.on("end", () => {});
process.on("exit", () => console.log("Wrote " + OUT));
