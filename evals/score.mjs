// Scoring for the review evals. Kept separate from run.mjs so it can be unit-tested.

/**
 * Compare the rule IDs a review flagged with what the case expects.
 * `allowed` lists rules that are fair to flag but not required (for example "needs a test"
 * on a small diff that has no test), so they count as neither a hit nor a false positive.
 */
export function scoreCase({ expected, allowed = [] }, flaggedRuleIds) {
  const got = new Set(flaggedRuleIds.filter((id) => id != null));
  const hits = expected.filter((id) => got.has(id));
  const missed = expected.filter((id) => !got.has(id));
  const extra = [...got].filter((id) => !expected.includes(id) && !allowed.includes(id));
  return { hits: hits.length, missed, extra, pass: missed.length === 0 && extra.length === 0 };
}

/** Recall: share of expected rule violations found. Precision: share of flagged rules that were right. */
export function summarize(results) {
  const expected = results.reduce((n, r) => n + r.hits + r.missed.length, 0);
  const hits = results.reduce((n, r) => n + r.hits, 0);
  const flagged = results.reduce((n, r) => n + r.hits + r.extra.length, 0);
  return {
    cases: results.length,
    passed: results.filter((r) => r.pass).length,
    recall: expected ? hits / expected : 1,
    precision: flagged ? hits / flagged : 1,
  };
}
