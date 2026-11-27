import {
  buildIntentMessages,
  INTENT_SCHEMA,
  looksLikeDiff,
  MAX_DIFF_CHARS,
  normalizeIntent,
  normalizeRepo,
  parsePrUrl,
} from "./lib";
import { MODEL } from "./workflow";

export { ReviewWorkflow } from "./workflow";
export { RepoMemory } from "./memory";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const MAX_BODY_CHARS = MAX_DIFF_CHARS * 2;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/chat" && request.method === "POST") {
        // Keeps one visitor from using up the account's daily Workers AI quota for everyone else.
        const { success } = await env.CHAT_LIMITER.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
        if (!success) return json({ error: "Too many messages. Wait a minute and try again." }, 429);
        return await chat(request, env);
      }

      const review = url.pathname.match(/^\/api\/reviews\/([\w-]{1,100})$/);
      if (review && request.method === "GET") {
        const instance = await env.REVIEW_WORKFLOW.get(review[1]).catch(() => null);
        if (!instance) return json({ error: "Review not found" }, 404);
        const s = await instance.status();
        return json({ id: review[1], status: s.status, output: s.output ?? null, error: s.error?.message ?? null });
      }

      if (url.pathname === "/api/memory" && request.method === "GET") {
        const repo = normalizeRepo(url.searchParams.get("repo"));
        const mem = env.REPO_MEMORY.getByName(repo);
        const [rules, reviews] = await Promise.all([mem.listRules(), mem.listReviews()]);
        return json({ repo, rules, reviews });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * One endpoint for the chat box. A PR URL or a diff starts a review Workflow;
 * anything else goes to the model, which decides whether it is a rule change.
 */
async function chat(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { repo?: unknown; message?: unknown } | null;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return json({ error: "message is required" }, 400);
  if (message.length > MAX_BODY_CHARS) return json({ error: `Message too long (max ${MAX_BODY_CHARS} characters)` }, 413);

  const pr = parsePrUrl(message);
  if (pr || looksLikeDiff(message)) {
    // A PR URL decides the repo; a pasted diff is filed under whatever repo the user picked.
    const repo = pr ? normalizeRepo(`${pr.owner}/${pr.repo}`) : normalizeRepo(body?.repo);
    const instance = await env.REVIEW_WORKFLOW.create({ params: pr ? { repo, pr } : { repo, diff: message } });
    return json({ type: "review_started", id: instance.id, repo });
  }

  const repo = normalizeRepo(body?.repo);
  const mem = env.REPO_MEMORY.getByName(repo);
  const rules = await mem.listRules();
  const out = (await env.AI.run(MODEL, {
    messages: buildIntentMessages(rules, message.slice(0, 2000)),
    response_format: { type: "json_schema", json_schema: INTENT_SCHEMA },
    max_tokens: 400,
    temperature: 0,
  })) as { response?: unknown };
  const intent = normalizeIntent(out.response);

  switch (intent.intent) {
    case "add_rule":
      return json({ type: "rules", repo, reply: `Added rule: "${intent.rule}"`, rules: await mem.addRule(intent.rule) });
    case "remove_rule": {
      const exists = rules.some((r) => r.id === intent.ruleId);
      const next = exists ? await mem.removeRule(intent.ruleId) : rules;
      return json({ type: "rules", repo, reply: exists ? `Removed rule ${intent.ruleId}.` : `There is no rule ${intent.ruleId}.`, rules: next });
    }
    case "list_rules":
      return json({ type: "rules", repo, reply: `${repo} has ${rules.length} rules.`, rules });
    default:
      return json({ type: "reply", repo, reply: intent.reply });
  }
}
