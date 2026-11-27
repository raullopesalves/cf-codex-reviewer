import { describe, expect, it } from "vitest";
import {
  buildReviewMessages,
  DEFAULT_REPO,
  extractJson,
  looksLikeDiff,
  normalizeIntent,
  normalizeRepo,
  normalizeReport,
  parsePrUrl,
  truncateDiff,
} from "../src/lib";

describe("routing input", () => {
  it("parses a GitHub PR URL inside a message", () => {
    expect(parsePrUrl("please review https://github.com/cloudflare/workers-sdk/pull/1234 thanks")).toEqual({
      owner: "cloudflare",
      repo: "workers-sdk",
      number: 1234,
    });
    expect(parsePrUrl("https://github.com/cloudflare/workers-sdk/issues/1234")).toBeNull();
    expect(parsePrUrl("https://evil.example/github.com/a/b/pull/1")).toBeNull();
  });

  it("recognises unified diffs but not prose", () => {
    expect(looksLikeDiff("diff --git a/x.ts b/x.ts\n+const a = 1")).toBe(true);
    expect(looksLikeDiff("@@ -1,3 +1,4 @@\n+foo")).toBe(true);
    expect(looksLikeDiff("--- a/x\n+++ b/x\n+foo")).toBe(true);
    expect(looksLikeDiff("from now on, flag any new dependency")).toBe(false);
  });

  it("normalises repo keys and falls back to the playground", () => {
    expect(normalizeRepo("  Octocat/Hello-World ")).toBe("octocat/hello-world");
    expect(normalizeRepo("../../etc")).toBe(DEFAULT_REPO);
    expect(normalizeRepo(42)).toBe(DEFAULT_REPO);
    expect(normalizeRepo("")).toBe(DEFAULT_REPO);
  });

  it("truncates long diffs and says so", () => {
    expect(truncateDiff("abc", 10)).toEqual({ diff: "abc", truncated: false });
    expect(truncateDiff("abcdef", 3)).toEqual({ diff: "abc", truncated: true });
  });
});

describe("model output", () => {
  it("extracts JSON from objects, fenced text and junk", () => {
    expect(extractJson({ a: 1 })).toEqual({ a: 1 });
    expect(extractJson('Here you go:\n```json\n{"a": 2}\n```')).toEqual({ a: 2 });
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson("{broken")).toBeNull();
  });

  it("normalises a report: clamps fields, sorts by severity, derives the verdict", () => {
    const report = normalizeReport({
      summary: "Two problems.",
      verdict: "approve",
      findings: [
        { ruleId: 2, severity: "low", file: "a.ts", issue: "No test", fix: "Add one" },
        { ruleId: 1, severity: "HIGH", file: "b.ts", issue: "Hardcoded key", fix: "Use a secret" },
        { ruleId: "x", severity: "weird", issue: "", fix: "dropped: no issue text" },
      ],
    });
    expect(report.findings.map((f) => f.severity)).toEqual(["high", "low"]);
    expect(report.findings[0].ruleId).toBe(1);
    // A high finding overrules the model's "approve".
    expect(report.verdict).toBe("request_changes");
  });

  it("approves when there are no findings and throws on garbage", () => {
    expect(normalizeReport('{"summary":"Clean.","verdict":"comment","findings":[]}').verdict).toBe("approve");
    expect(() => normalizeReport("I cannot help with that")).toThrow();
  });

  it("maps intents and falls back to help", () => {
    expect(normalizeIntent({ intent: "add_rule", rule: "Flag any new dependency." })).toEqual({
      intent: "add_rule",
      rule: "Flag any new dependency.",
    });
    expect(normalizeIntent({ intent: "remove_rule", ruleId: 3 })).toEqual({ intent: "remove_rule", ruleId: 3 });
    expect(normalizeIntent({ intent: "remove_rule" }).intent).toBe("help");
    expect(normalizeIntent({ intent: "add_rule", rule: "" }).intent).toBe("help");
    expect(normalizeIntent(null).intent).toBe("help");
  });
});

describe("prompt", () => {
  it("numbers the rules, includes memory and marks the diff as untrusted", () => {
    const [system, user] = buildReviewMessages(
      [{ id: 7, text: "No secrets.", source: "default" }],
      "+const key = 'sk-123'",
      ["[high] a.ts: Hardcoded key"],
    );
    expect(system.content).toContain("7. No secrets.");
    expect(system.content).toContain("[high] a.ts: Hardcoded key");
    expect(system.content).toContain("untrusted");
    expect(user.content).toContain("sk-123");
  });
});
