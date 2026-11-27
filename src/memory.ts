import { DurableObject } from "cloudflare:workers";
import { DEFAULT_RULES, MAX_RULES, MAX_RULE_CHARS, type Report, type Rule, findingDigest } from "./lib";

export interface ReviewRecord {
  id: string;
  createdAt: string;
  source: string;
  verdict: Report["verdict"];
  summary: string;
  findings: number;
}

/**
 * One instance per repo (addressed by name, e.g. "octocat/hello-world").
 * Holds that repo's rules and its review history in the Durable Object's own SQLite database.
 */
export class RepoMemory extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL,
      verdict TEXT NOT NULL,
      summary TEXT NOT NULL,
      findings_json TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    // Seed once per repo; a user who deletes every rule should not get the defaults back.
    if (this.sql.exec("SELECT 1 FROM meta WHERE key = 'seeded'").toArray().length === 0) {
      for (const text of DEFAULT_RULES) this.sql.exec("INSERT INTO rules (text, source) VALUES (?, 'default')", text);
      this.sql.exec("INSERT INTO meta (key, value) VALUES ('seeded', '1')");
    }
  }

  listRules(): Rule[] {
    return this.sql.exec<{ id: number; text: string; source: Rule["source"] }>("SELECT id, text, source FROM rules ORDER BY id").toArray();
  }

  addRule(text: string): Rule[] {
    const clean = text.trim().slice(0, MAX_RULE_CHARS);
    if (!clean) throw new Error("Rule text is empty");
    const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM rules").one().n;
    if (count >= MAX_RULES) throw new Error(`A repo can hold at most ${MAX_RULES} rules`);
    this.sql.exec("INSERT INTO rules (text, source) VALUES (?, 'user')", clean);
    return this.listRules();
  }

  removeRule(id: number): Rule[] {
    this.sql.exec("DELETE FROM rules WHERE id = ?", id);
    return this.listRules();
  }

  /** What a review needs: the rules, plus a digest of recent findings so the model can spot repeats. */
  getReviewContext(): { rules: Rule[]; pastFindings: string[] } {
    const rows = this.sql.exec<{ findings_json: string }>("SELECT findings_json FROM reviews ORDER BY rowid DESC LIMIT 5").toArray();
    const pastFindings = rows.flatMap((r) => JSON.parse(r.findings_json) as string[]).slice(0, 10);
    return { rules: this.listRules(), pastFindings };
  }

  recordReview(id: string, source: string, report: Report): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO reviews (id, source, verdict, summary, findings_json) VALUES (?, ?, ?, ?, ?)",
      id,
      source,
      report.verdict,
      report.summary,
      JSON.stringify(report.findings.map(findingDigest)),
    );
    // Keep the history bounded.
    this.sql.exec("DELETE FROM reviews WHERE id NOT IN (SELECT id FROM reviews ORDER BY rowid DESC LIMIT 50)");
  }

  listReviews(): ReviewRecord[] {
    return this.sql
      .exec<{ id: string; created_at: string; source: string; verdict: Report["verdict"]; summary: string; findings_json: string }>(
        "SELECT * FROM reviews ORDER BY rowid DESC LIMIT 10",
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        source: r.source,
        verdict: r.verdict,
        summary: r.summary,
        findings: (JSON.parse(r.findings_json) as string[]).length,
      }));
  }
}
