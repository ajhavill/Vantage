// Vantage — Propensity-to-move scoring configuration.
//
// THIS IS THE TUNING FILE. Edit the numbers here to change how the score behaves;
// the math that reads them lives in _propensity.js. Weights are a weighted
// composite — each component is normalized to 0..1, multiplied by its weight,
// summed, and scaled to 0..100. Keep the weights summing to ~1.0.
//
// Priority order (per spec): lease-expiration proximity carries the most weight,
// then headcount trajectory, then funding/M&A recency, then the sublease "tell".

module.exports = {
  // ---- Component weights (should sum to ~1.0) ----
  weights: {
    expiration: 0.50, // proximity to / inside the renewal window — the single biggest driver
    headcount:  0.20, // magnitude of recent headcount change (growth OR shrink both signal a move)
    funding:    0.20, // recency of a funding round or M&A event
    sublease:   0.10  // sublease listed = contraction "tell"
  },

  // ---- Renewal window (months to lease expiration) ----
  // The 18–24 month band is when tenant-rep engagement is won. Inside it, the
  // expiration component scores full marks and the tenant gets a "renewal window" flag.
  renewalWindow: { minMonths: 18, maxMonths: 24 },

  // ---- Expiration component curve (input: months to expiration) ----
  expiration: {
    horizonMonths: 48,      // beyond this many months out, expiration signal ≈ 0
    expiredScore: 0.80,     // lease already expired (holdover) — strong but not peak
    nearTermFloor: 0.75     // score at 0 months, ramping up to 1.0 at the window's near edge
  },

  // ---- Headcount component (input: % change across the lookback) ----
  headcount: {
    lookbackDays: 365,      // compare the latest snapshot to the oldest within this window
    fullDeltaPct: 0.25,     // a ±25% swing maps to a full-strength headcount signal
    minSnapshots: 2         // need at least this many readings to compute a trend
  },

  // ---- Funding / M&A component (input: days since funding_last_date) ----
  funding: {
    recencyDays: 540        // a round within ~18 months decays linearly from 1 → 0
  },

  // ---- Reason-chip thresholds (what's worth surfacing as an explanation) ----
  chips: {
    headcountMinPct: 0.05,  // only show a headcount chip past a ±5% move
    minComponentToShow: 0.5 // component contribution (in score points) below this is not chipped
  }
};
