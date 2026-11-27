// Runs the eval cases against a deployment and prints a Markdown report.
// Usage: node evals/run.mjs [--url https://<worker>.workers.dev] [--runs 3]
import { cases } from "./cases.mjs";
import { scoreCase, summarize } from "./score.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg("url", process.env.SMOKE_URL ?? "https://codex-reviewer.codex-reviewer.workers.dev");
const RUNS = Number(arg("runs", "1"));
const stamp = Date.now().toString(36);

async function post(repo, message, attempt = 1) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, message }),
  });
  // The app rate-limits /api/chat per IP; wait out the window instead of dropping the case.
  if (res.status === 429 && attempt < 5) {
    await new Promise((r) => setTimeout(r, 20_000));
    return post(repo, message, attempt + 1);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${data.error}`);
  return data;
}

async function review(repo, diff) {
  const { id } = await post(repo, diff);
  const started = Date.now();
  while (Date.now() - started < 240_000) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await (await fetch(`${BASE}/api/reviews/${id}`)).json();
    if (s.status === "complete") return s.output.report;
    if (s.status === "errored" || s.status === "terminated") throw new Error(`review ${id} ${s.status}: ${s.error}`);
  }
  throw new Error(`review ${id} timed out`);
}

async function runCase(c, i, run) {
  // A fresh repo per case and run, so earlier findings in repo memory cannot leak into the result.
  const repo = `eval/${stamp}-r${run}-c${i}`;
  if (c.addRule) await post(repo, c.addRule);
  const started = Date.now();
  const report = await review(repo, c.diff);
  return { name: c.name, run, seconds: (Date.now() - started) / 1000, verdict: report.verdict, flagged: report.findings.map((f) => f.ruleId), ...scoreCase(c, report.findings.map((f) => f.ruleId)) };
}

const jobs = [];
for (let run = 1; run <= RUNS; run++) cases.forEach((c, i) => jobs.push(() => runCase(c, i, run)));

// Three at a time keeps well under the per-IP chat rate limit.
const results = [];
const queue = [...jobs];
await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const job = queue.shift();
      try {
        results.push(await job());
      } catch (err) {
        console.error(String(err));
      }
    }
  }),
);

const fmt = (ids) => (ids.length ? ids.join(", ") : "none");
console.log(`| Case | Run | Expected | Flagged | Missed | Extra | Pass |\n| --- | --- | --- | --- | --- | --- | --- |`);
for (const r of results.sort((a, b) => cases.findIndex((c) => c.name === a.name) - cases.findIndex((c) => c.name === b.name) || a.run - b.run)) {
  const c = cases.find((x) => x.name === r.name);
  console.log(`| ${r.name} | ${r.run} | ${fmt(c.expected)} | ${fmt(r.flagged.filter((x) => x != null))} | ${fmt(r.missed)} | ${fmt(r.extra)} | ${r.pass ? "yes" : "no"} |`);
}
const s = summarize(results);
const failedToRun = jobs.length - results.length;
console.log(`\n${s.passed}/${s.cases} cases passed; recall ${(s.recall * 100).toFixed(0)}%, precision ${(s.precision * 100).toFixed(0)}%` + (failedToRun ? `; ${failedToRun} case(s) failed to run` : ""));
process.exitCode = failedToRun ? 1 : 0;
