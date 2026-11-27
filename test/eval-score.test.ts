import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module without type declarations
import { scoreCase, summarize } from "../evals/score.mjs";

describe("eval scoring", () => {
  it("counts hits, misses and extras, ignoring allowed rules", () => {
    expect(scoreCase({ expected: [1, 3], allowed: [2] }, [1, 2, 5, null])).toEqual({ hits: 1, missed: [3], extra: [5], pass: false });
    expect(scoreCase({ expected: [], allowed: [2] }, [2])).toEqual({ hits: 0, missed: [], extra: [], pass: true });
  });

  it("summarises recall and precision across cases", () => {
    const s = summarize([
      { hits: 1, missed: [3], extra: [5], pass: false },
      { hits: 2, missed: [], extra: [], pass: true },
    ]);
    expect(s).toEqual({ cases: 2, passed: 1, recall: 3 / 4, precision: 3 / 4 });
  });
});
