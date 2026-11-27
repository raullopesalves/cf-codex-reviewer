# Codex reviewer

A small chat app that reviews code changes against a repo's own engineering rules. Paste a unified diff or a public GitHub pull request link. A durable Workflow reviews it with Llama 3.3 on Workers AI and returns a report with a severity for each finding and a suggested fix. Each repo has its own memory (a Durable Object) that holds its rules and its review history. You change the rules by chatting: *"from now on, flag any new dependency added to package.json"*.

**Live:** https://codex-reviewer.codex-reviewer.workers.dev

## What it does

- **Review a change.** Paste a diff or a link such as `https://github.com/owner/repo/pull/123`. The report gives a verdict (approve / comment / changes requested). Each finding has a severity, the file, the rule it breaks and a concrete fix. Hover a finding's rule link to highlight that rule in the side panel.
- **Teach it rules.** Type a plain sentence to add a rule ("flag any use of `eval`"), remove one ("drop rule 3") or list them ("what are the rules?"). The model turns your sentence into an `add_rule`, `remove_rule` or `list_rules` action. The Worker validates the action before it changes anything.
- **Remember per repo.** A PR link selects its own repo (`owner/repo`). Pasted diffs go to the repo named in the side panel (`playground` by default). Each repo starts with five starter rules. The last findings are fed into the next review, so the model can point out a problem that comes back.

## Architecture

```
Browser (public/index.html)
   │  POST /api/chat           GET /api/reviews/:id (poll)      GET /api/memory?repo=
   ▼
Worker (src/index.ts) ── routes the message
   │ diff or PR link                            │ anything else
   ▼                                            ▼
ReviewWorkflow (src/workflow.ts)           Workers AI: intent → add / remove / list rule
  1. fetch diff        (retries 3x)              │
  2. load rules + memory ──────────┐             ▼
  3. review with Llama 3.3 (JSON schema, retries 2x)   RepoMemory Durable Object (src/memory.ts)
  4. save findings ────────────────┴──────────▶  one per repo, SQLite: rules, reviews
```

| Building block | How it is built |
| --- | --- |
| LLM | Workers AI, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, with JSON mode (`response_format: json_schema`) for the review report and for the rule intents. |
| Workflow / coordination | Cloudflare **Workflows**. `ReviewWorkflow` runs the review as four durable steps. A failed model call retries only that step. The diff is not fetched again and findings are not written twice. The Worker also routes chat messages and calls the Durable Object over RPC. |
| User input (chat) | A chat UI served as **Workers static assets** from the same Worker. Pages is not needed. |
| Memory / state | A **Durable Object** per repo (`RepoMemory`, SQLite storage) holds the rules and the last 50 reviews. Workflows also keeps each step's output as durable state. |

### Files

- `src/index.ts`: the HTTP routes and the chat router (review, or rule change).
- `src/workflow.ts`: the `ReviewWorkflow` steps and retry policy.
- `src/memory.ts`: the `RepoMemory` Durable Object, with its rules, review history and starter rules.
- `src/lib.ts`: pure logic: input parsing, prompts, JSON schemas and normalisation of model output. It has no Cloudflare imports, so it is unit-tested in plain Node.
- `public/index.html`: the chat UI in one file (vanilla JS, no build step).
- `test/`: unit tests (Vitest). `smoke/`: an end-to-end Playwright test that runs against a deployment. `evals/`: labelled diffs and a runner that scores review quality.

## Run and deploy

Requirements: Node 22+ and a Cloudflare account (the free plan covers Workers AI, Workflows and SQLite Durable Objects).

```sh
npm install
npx wrangler login
npm run dev          # http://localhost:8787 (Workers AI always runs remotely, so a login is needed even locally)
npm run deploy       # prints the workers.dev URL
```

Checks:

```sh
npm run typecheck    # wrangler types --check + tsc
npm test             # unit tests
SMOKE_URL=https://<your-worker>.workers.dev npm run smoke   # Playwright on your installed Chrome, desktop + mobile, real model
npm run eval -- --url https://<your-worker>.workers.dev --runs 3   # review-quality evals, see below
```

CI (`.github/workflows/ci.yml`) runs the typecheck and the unit tests on every push. The smoke test and the evals run against a live deployment with a real model, so they are run by hand after a deploy and not on every push.

## Evals

A model-backed reviewer needs a way to tell whether a prompt or model change made it better or worse. [`evals/cases.mjs`](evals/cases.mjs) holds nine small diffs, each labelled with the rules it must trigger:

- one case for each starter rule;
- a diff that breaks two rules at once;
- a diff whose comments tell the reviewer to ignore its rules and approve (prompt injection);
- two clean changes that must produce no findings;
- a rule added through chat ("flag any new dependency"), followed by a diff that breaks it.

`npm run eval` runs every case in a fresh repo against the deployed app. It scores **recall** (expected violations found) and **precision** (flagged rules that were right). "Needs a test" is allowed but not required on small diffs that come without tests, so flagging it is neither a hit nor a false positive.

Latest result: 3 runs × 9 cases with Llama 3.3 70B, temperature 0.2.

| | |
| --- | --- |
| Cases passed | 25 / 27 |
| Recall | 100% |
| Precision | 92% |
| Prompt injection resisted | 3 / 3 |
| Clean changes left clean | 6 / 6 |

Both failures are the SQL-injection case. In 2 of 3 runs it also flagged rule 3 (error handling) on a route without a `try`/`catch`, which is arguable but not what the rule means.

## Design decisions and trade-offs

- **The Workflow does the review, not the request.** A 70B model call over a large diff can take tens of seconds and sometimes fails. If the review ran inside the HTTP request, a timeout would lose the work. With a Workflow, each step is checkpointed and retried on its own, and the browser only polls for status. The cost is a polling loop in the UI. A WebSocket or `instance.subscribe` would remove it, but polling is enough here.
- **One Durable Object per repo.** Each repo's rules and history sit in one place, so writes are consistent and no shared database is needed. The DO is addressed by name (`getByName("owner/repo")`). Repos do not need to share data, so they do not need a global store.
- **Rules come from the user, through the model, with checks.** The model only classifies the message and extracts the rule text. The Worker clamps the length (300 characters) and the count (30 rules), and it checks that a rule exists before removing it.
- **Model output is treated as untrusted.** JSON mode makes the output parseable, and `normalizeReport` still validates every field. It sorts findings by severity and derives the verdict from the findings: a high-severity finding always means "changes requested", whatever verdict the model wrote. If the output cannot be parsed, the step throws and Workflows retries it.
- **The diff is treated as untrusted too.** The prompt tells the model to ignore any instructions written in the diff. The PR fetch URL is built only from the parsed owner, repo and number, so user input cannot point the fetch at any host other than github.com (no SSRF). The UI renders all model text as text, never as HTML.
- **Kept small on purpose.** Diffs are cut at 30,000 characters (the report says when this happens) to stay inside the model's 24k-token context. There are no accounts and no auth: anyone with the link shares the same repo memories, which is fine for a demo but not for real use. `/api/chat` is the only route that calls the model, and it is rate-limited per IP (20 messages a minute, Workers rate-limiting binding). This keeps one visitor from using up the account's daily Workers AI quota for everyone else. Only public PRs work, because no GitHub token is used.

### What I'd do next

GitHub App webhook to review PRs automatically and post comments; per-file chunking with a map-reduce step for big PRs; a larger eval set run in CI on every prompt change, with a precision threshold as a gate; auth plus per-org rule sets; Workers AI streaming for the summary.

## Prompt history

I built this app with Claude Code. The session transcript is in [`prompts/claude-code-session.md`](prompts/claude-code-session.md). It holds the conversation (prompts, replies and clarifying questions); tool calls, their outputs and some personal details are left out.
