// Sensor Turing test on Cloudflare Pages Functions: answers are checked against the published rounds
// (/static/turing_rounds.json) and counted in a D1 database (binding DB), so the crowd score survives redeploys.

export interface Env {
  DB: D1Database;
  ASSETS: { fetch: (req: Request | string) => Promise<Response> };
}
interface D1Database {
  prepare: (sql: string) => { bind: (...v: unknown[]) => { run: () => Promise<unknown>; all: <T>() => Promise<{ results: T[] }> }; all: <T>() => Promise<{ results: T[] }> };
  exec: (sql: string) => Promise<unknown>;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
export const err = (code: string, message: string, status: number) => json({ error: { code, message } }, status);

export async function ensureTable(env: Env) {
  await env.DB.exec("CREATE TABLE IF NOT EXISTS answers (id INTEGER PRIMARY KEY AUTOINCREMENT, set_name TEXT NOT NULL, correct INTEGER NOT NULL, ts INTEGER NOT NULL)");
}
