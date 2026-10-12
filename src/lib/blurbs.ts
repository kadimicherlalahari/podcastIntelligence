// One-line context for the Rankings tabs: who a guest is, what a topic's episodes are about, what a sponsor sells.
// Gemini writes them from our own episode data in one batched call per tab; results are cached in `blurbs`.
import { db } from "./db-core";
import { generateJson } from "./gemini";

export type BlurbType = "guest" | "topic" | "brand";

const DAY = 86_400_000;
// People and companies rarely change; what a topic's episodes discuss moves week to week.
const MAX_AGE: Record<BlurbType, number> = { guest: 60 * DAY, brand: 60 * DAY, topic: 6 * DAY };
const BATCH = 30;

const SYSTEM = `You write one-line notes for an Indian podcast booking team's dashboard. Each item comes with context from podcast episodes we monitor.
- guest: who this person is, e.g. "Co-founder & CEO of Zepto, the 10-minute grocery delivery startup." Use what you reliably know about the person plus the context. Do not guess at a well-known person who only shares the name; if the context doesn't make it clear, describe them from the context only.
- topic: what the episodes tagged with this topic are actually discussing right now, based on the episode titles given. Be specific (names, themes), not a dictionary definition.
- brand: what the company or product is and what it sells, e.g. "Indian online stock broker offering zero-brokerage equity investing."
Rules: one sentence, at most 22 words, plain text, no leading name repetition, no hype, no markdown. Never invent facts that conflict with the context. Return an entry for every id.`;

/** Context lines for each id, built from extracted episodes. */
async function contexts(type: BlurbType, ids: string[]): Promise<Map<string, { name: string; context: string }>> {
  const marks = ids.map(() => "?").join(",");
  const sql = {
    guest: `select g.id, g.canonical_name name,
              trim(coalesce(g.role, '') || ' ' || coalesce(g.company, '')) detail,
              (select group_concat(t, ' | ') from (select e.title t from appearances a join episodes e on e.id = a.episode_id
                 where a.guest_id = g.id order by e.published_at desc limit 3)) titles,
              (select group_concat(ev, ' | ') from (select evidence ev from appearances where guest_id = g.id and evidence is not null limit 2)) quotes
            from guests g where g.id in (${marks})`,
    brand: `select b.id, b.canonical_name name, coalesce(b.category, '') detail,
              (select group_concat(t, ' | ') from (select e.title t from brand_mentions m join episodes e on e.id = m.episode_id
                 where m.brand_id = b.id order by e.published_at desc limit 2)) titles,
              (select group_concat(ev, ' | ') from (select evidence ev from brand_mentions where brand_id = b.id and evidence is not null limit 3)) quotes
            from brands b where b.id in (${marks})`,
    topic: `select t.slug id, t.label name, '' detail,
              (select group_concat(ti, ' | ') from (select e.title ti from episode_topics et join episodes e on e.id = et.episode_id
                 where et.topic_id = t.id and e.kind = 'full' and e.status = 'extracted' order by e.published_at desc limit 12)) titles,
              null quotes
            from topics t where t.slug in (${marks})`,
  }[type];
  const { rows } = await db().execute({ sql, args: ids });
  return new Map(rows.map((r) => [String(r.id), {
    name: String(r.name),
    context: [r.detail && `role/details: ${r.detail}`, r.titles && `episodes: ${r.titles}`, r.quotes && `quotes: ${r.quotes}`]
      .filter(Boolean).join("; ").slice(0, 1500) || "no other context",
  }]));
}

async function write(type: BlurbType, ids: string[]): Promise<Map<string, string>> {
  const ctx = await contexts(type, ids);
  const items = [...ctx].map(([id, c]) => `- id: ${id}\n  name: ${c.name}\n  ${c.context}`).join("\n");
  const res = await generateJson<{ items: { id: string; text: string }[] }>({
    system: SYSTEM,
    prompt: `Type: ${type}\n\n${items}`,
    schema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"] } },
      },
      required: ["items"],
    },
    retries: 2,
  });
  const out = new Map(res.items.filter((i) => ctx.has(i.id) && i.text.trim()).map((i) => [i.id, i.text.trim()]));
  if (out.size) {
    await db().batch([...out].map(([id, text]) => ({
      sql: `insert into blurbs (entity_type, entity_id, text, created_at) values (?, ?, ?, ?)
            on conflict (entity_type, entity_id) do update set text = excluded.text, created_at = excluded.created_at`,
      args: [type, id, text, new Date().toISOString()],
    })), "write");
  }
  return out;
}

/**
 * Cached one-liners for `ids` (guest ids, brand ids, or topic slugs). Missing or stale ones are written in one Gemini
 * call per batch; if Gemini fails, stale copies are still returned and the rest are simply absent.
 */
export async function getBlurbs(type: BlurbType, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const { rows } = await db().execute({
    sql: `select entity_id, text, created_at from blurbs where entity_type = ? and entity_id in (${ids.map(() => "?").join(",")})`,
    args: [type, ...ids],
  });
  const out = new Map(rows.map((r) => [String(r.entity_id), String(r.text)]));
  const fresh = new Set(rows.filter((r) => Date.now() - Date.parse(String(r.created_at)) < MAX_AGE[type]).map((r) => String(r.entity_id)));
  const todo = ids.filter((id) => !fresh.has(id));
  const batches = Array.from({ length: Math.ceil(todo.length / BATCH) }, (_, i) => todo.slice(i * BATCH, (i + 1) * BATCH));
  const results = await Promise.allSettled(batches.map((b) => write(type, b)));
  for (const r of results) {
    if (r.status === "fulfilled") for (const [id, text] of r.value) out.set(id, text);
    else console.error(`blurbs (${type}):`, (r.reason as Error).message);
  }
  return out;
}
