import { ensureTable, err, json, type Env } from "./_shared";

export const onRequestGet = async ({ env }: { env: Env }) => {
  try {
    await ensureTable(env);
    const { results } = await env.DB.prepare("SELECT set_name, COUNT(*) AS n, SUM(correct) AS k FROM answers GROUP BY set_name").all<{ set_name: string; n: number; k: number }>();
    const out: Record<string, { n: number; accuracy: number | null }> = { raw: { n: 0, accuracy: null }, harmonized: { n: 0, accuracy: null } };
    for (const r of results) out[r.set_name] = { n: r.n, accuracy: r.n ? Math.round((1000 * r.k) / r.n) / 1000 : null };
    return json(out);
  } catch {
    return err("upstream_unavailable", "The crowd score is not available right now.", 503);
  }
};
