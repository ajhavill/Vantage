// Vantage — Propensity-to-move scoring (pure logic; tuning lives in _propensity-config.js).
//
// score(tenant, snapshots, now) -> {
//   score,               // 0..100 composite
//   monthsToExpiration,   // number | null   (priority-1 field, surfaced on its own too)
//   renewalFlag,          // true if inside the 18–24mo window
//   headcountDeltaPct,    // number | null   (signed; + = growth, - = contraction)
//   chips: [{label, tone}],   // human-readable drivers, most-impactful first
//   components            // { expiration, headcount, funding, sublease } in score points
// }
//
// `tenant` is the normalized object from tenants-list (numbers/dates already parsed).
// `snapshots` is the ascending time-series [{captured_at, headcount}] for this company.

const CFG = require("./_propensity-config");

const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.4375;

function monthsBetween(fromDate, toDate) {
  return (toDate.getTime() - fromDate.getTime()) / MS_PER_MONTH;
}

// ---- component sub-scores (each returns 0..1) ----

function expirationSub(mte) {
  if (mte === null || mte === undefined || isNaN(mte)) return 0;
  const { minMonths, maxMonths } = CFG.renewalWindow;
  const { horizonMonths, expiredScore, nearTermFloor } = CFG.expiration;
  if (mte < 0) return expiredScore;                     // already expired (holdover)
  if (mte >= minMonths && mte <= maxMonths) return 1;   // inside the renewal window — peak
  if (mte < minMonths) {                                // nearer than the window
    return nearTermFloor + (1 - nearTermFloor) * (mte / minMonths);
  }
  // farther out than the window — decay to 0 at the horizon
  const span = horizonMonths - maxMonths;
  return Math.max(0, 1 - (mte - maxMonths) / span);
}

// Returns { sub, deltaPct } from the headcount time-series.
function headcountSub(snapshots, now) {
  const cfg = CFG.headcount;
  if (!Array.isArray(snapshots) || snapshots.length < cfg.minSnapshots) {
    return { sub: 0, deltaPct: null };
  }
  const cutoff = now.getTime() - cfg.lookbackDays * 24 * 60 * 60 * 1000;
  const inWindow = snapshots.filter(s => new Date(s.captured_at).getTime() >= cutoff);
  const series = inWindow.length >= cfg.minSnapshots ? inWindow : snapshots;
  const first = series[0];
  const last = series[series.length - 1];
  const base = Number(first.headcount);
  const end = Number(last.headcount);
  if (!base || base <= 0) return { sub: 0, deltaPct: null };
  const deltaPct = (end - base) / base;
  const sub = Math.min(1, Math.abs(deltaPct) / cfg.fullDeltaPct); // growth or shrink both count
  return { sub: sub, deltaPct: deltaPct };
}

function fundingSub(fundingDate, now) {
  if (!fundingDate) return 0;
  const ageDays = (now.getTime() - fundingDate.getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays < 0) return 0;
  return Math.max(0, 1 - ageDays / CFG.funding.recencyDays);
}

function score(tenant, snapshots, now) {
  now = now || new Date();
  const w = CFG.weights;

  const mte = tenant.leaseExpiration ? monthsBetween(now, tenant.leaseExpiration) : null;
  const renewalFlag = mte !== null &&
    mte >= CFG.renewalWindow.minMonths && mte <= CFG.renewalWindow.maxMonths;

  const eSub = expirationSub(mte);
  const hc = headcountSub(snapshots, now);
  const fSub = fundingSub(tenant.fundingDate, now);
  const sSub = tenant.subleaseFlag ? 1 : 0;

  const components = {
    expiration: eSub * w.expiration * 100,
    headcount:  hc.sub * w.headcount * 100,
    funding:    fSub * w.funding * 100,
    sublease:   sSub * w.sublease * 100
  };
  const total = Math.round(components.expiration + components.headcount + components.funding + components.sublease);

  return {
    score: total,
    monthsToExpiration: mte === null ? null : Math.round(mte * 10) / 10,
    renewalFlag: renewalFlag,
    headcountDeltaPct: hc.deltaPct,
    components: components,
    chips: buildChips(tenant, mte, renewalFlag, hc.deltaPct, components, now)
  };
}

// ---- reason chips: explain what drove the score, most-impactful first ----
function buildChips(tenant, mte, renewalFlag, deltaPct, components, now) {
  const chips = [];
  const min = CFG.chips.minComponentToShow;

  // Expiration
  if (components.expiration >= min && mte !== null) {
    if (renewalFlag) {
      chips.push({ key: "expiration", weight: components.expiration, tone: "hot",
        label: "Renewal window · " + Math.round(mte) + " mo out" });
    } else if (mte < 0) {
      chips.push({ key: "expiration", weight: components.expiration, tone: "hot",
        label: "Lease expired · holdover" });
    } else if (mte < CFG.renewalWindow.minMonths) {
      chips.push({ key: "expiration", weight: components.expiration, tone: "warn",
        label: "Expires in " + Math.round(mte) + " mo" });
    } else {
      chips.push({ key: "expiration", weight: components.expiration, tone: "info",
        label: "Expires in " + Math.round(mte) + " mo" });
    }
  }

  // Headcount trajectory
  if (components.headcount >= min && deltaPct !== null && Math.abs(deltaPct) >= CFG.chips.headcountMinPct) {
    const pct = Math.round(deltaPct * 100);
    const grew = deltaPct > 0;
    chips.push({ key: "headcount", weight: components.headcount, tone: grew ? "info" : "warn",
      label: "Headcount " + (grew ? "+" : "") + pct + "% " + (grew ? "(outgrowing)" : "(contracting)") });
  }

  // Funding / M&A recency
  if (components.funding >= min && tenant.fundingDate) {
    const months = Math.max(0, Math.round((now.getTime() - tenant.fundingDate.getTime()) / MS_PER_MONTH));
    const round = tenant.fundingRound ? String(tenant.fundingRound) + " · " : "";
    chips.push({ key: "funding", weight: components.funding, tone: "info",
      label: "Funded " + round + months + " mo ago" });
  }

  // Sublease contraction tell
  if (components.sublease >= min && tenant.subleaseFlag) {
    chips.push({ key: "sublease", weight: components.sublease, tone: "warn",
      label: "Sublease listed" });
  }

  chips.sort((a, b) => b.weight - a.weight);
  return chips.map(c => ({ label: c.label, tone: c.tone }));
}

module.exports = { score: score };
