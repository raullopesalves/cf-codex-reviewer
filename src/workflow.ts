import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { type PrRef, type Report, buildReviewMessages, normalizeReport, REPORT_SCHEMA, truncateDiff } from "./lib";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export interface ReviewParams {
  repo: string;
  /** Either a pasted diff or a PR reference; never both. */
  diff?: string;
  pr?: PrRef;
}

export interface ReviewResult {
  repo: string;
  source: string;
  truncated: boolean;
  rulesChecked: number;
  report: Report;
}

/**
 * The review pipeline. Each step's result is persisted by Workflows, so a failure in the
 * model call retries only that step and never refetches the diff or double-writes memory.
 */
export class ReviewWorkflow extends WorkflowEntrypoint<Env, ReviewParams> {
  async run(event: WorkflowEvent<ReviewParams>, step: WorkflowStep): Promise<ReviewResult> {
    const { repo, pr } = event.payload;
    const source = pr ? `${pr.owner}/${pr.repo}#${pr.number}` : "pasted diff";

    const { diff, truncated } = await step.do("fetch diff", { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" } }, async () => {
      if (!pr) return truncateDiff(event.payload.diff ?? "");
      // The URL is built from the parsed parts only, so user input cannot point this fetch anywhere but github.com.
      const url = `https://github.com/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pull/${pr.number}.diff`;
      const res = await fetch(url, { headers: { "User-Agent": "codex-reviewer-demo" } });
      if (res.status === 404) throw new NonRetryableError(`PR not found or not public: ${source}`);
      if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${source}`);
      return truncateDiff(await res.text());
    });
    if (!diff.trim()) throw new NonRetryableError("The diff is empty");

    const context = await step.do("load repo rules and memory", async () => {
      return this.env.REPO_MEMORY.getByName(repo).getReviewContext();
    });

    const report = await step.do("review with Llama 3.3", { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "3 minutes" }, async () => {
      const out = (await this.env.AI.run(MODEL, {
        messages: buildReviewMessages(context.rules, diff, context.pastFindings),
        response_format: { type: "json_schema", json_schema: REPORT_SCHEMA },
        max_tokens: 2048,
        temperature: 0.2,
      })) as { response?: unknown };
      // normalizeReport throws on unparseable output, which makes Workflows retry this step.
      return normalizeReport(out.response);
    });

    await step.do("save findings to repo memory", async () => {
      await this.env.REPO_MEMORY.getByName(repo).recordReview(event.instanceId, source, report);
    });

    return { repo, source, truncated, rulesChecked: context.rules.length, report };
  }
}
