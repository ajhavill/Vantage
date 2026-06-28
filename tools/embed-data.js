#!/usr/bin/env node
/*
  Bakes the current site/public/vantage-data.json into site/public/index.html as
  the file:// / offline fallback, by replacing the embedded BUILDINGS, ROSTERS,
  DEFAULT_CATEGORIES and DEFAULT_INDUSTRIES literals. After this, index.html alone
  shows the full real data even with no external JSON present. The external
  vantage-data.json still wins whenever it loads.

  Re-run this whenever the data changes meaningfully:  node tools/embed-data.js
*/
const fs = require("fs");
const path = require("path");
const IDX = path.join(__dirname, "..", "site", "public", "index.html");
const DATA = path.join(__dirname, "..", "site", "public", "vantage-data.json");

function literalEnd(s, openIdx) {
  const open = s[openIdx], close = open === "[" ? "]" : "}";
  let depth = 0, inStr = false, q = "";
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === "\\") { i++; continue; } if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; q = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
  }
  throw new Error("unbalanced literal");
}
function replaceVar(html, name, value) {
  const marker = "var " + name + "=";
  const start = html.indexOf(marker);
  if (start < 0) throw new Error("not found: " + name);
  const openIdx = start + marker.length;
  const end = literalEnd(html, openIdx);
  const semi = html.indexOf(";", end);
  return html.slice(0, start) + marker + JSON.stringify(value) + ";" + html.slice(semi + 1);
}

const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
let html = fs.readFileSync(IDX, "utf8");
html = replaceVar(html, "BUILDINGS", data.buildings);
html = replaceVar(html, "ROSTERS", data.rosters);
html = replaceVar(html, "DEFAULT_CATEGORIES", data.categories);
html = replaceVar(html, "DEFAULT_INDUSTRIES", data.industries);
fs.writeFileSync(IDX, html, "utf8");

const re = fs.readFileSync(IDX, "utf8");
const bStart = re.indexOf("var BUILDINGS=") + "var BUILDINGS=".length;
const embedded = JSON.parse(re.slice(bStart, literalEnd(re, bStart) + 1));
const amen = embedded.reduce((n, b) => n + (b.amen ? b.amen.length : 0), 0);
console.log("Embedded " + embedded.length + " buildings, " + amen + " amenities, " +
  embedded.filter(b => (b.photos || []).length).length + " w/ photos, " +
  embedded.filter(b => b.drive).length + " w/ drive into index.html.");
console.log("index.html size: " + (fs.statSync(IDX).size / 1024).toFixed(0) + " KB");
