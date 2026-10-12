import { Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import {
  ArrowLeft, ArrowUpRight, BadgeCheck, CircleAlert, Eye, Mic, Newspaper, Quote, RefreshCw, Search, Sparkles, UsersRound,
} from "lucide-react";
import { db } from "@/lib/db";
import { enrichGuest, type GuestBasics } from "@/lib/enrich";
import { SubmitButton } from "@/components/client";
import { Panel, Pill, Section, ShowName, Skeleton, ago, btn, fmtDate, n, showColor } from "@/components/ui";
import { refreshGuest } from "./actions";

export const metadata = { title: "Guest" };

const DAY = 86_400_000;
const compact = (v: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);
const plural = (c: number, one: string, many = `${one}s`) => `${c} ${c === 1 ? one : many}`;
const withinDays = (iso: string, days: number) => Date.now() - Date.parse(iso) < days * DAY;
const headline = (t: string) => t.split(" | ")[0].trim() || t;

export default function GuestPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <>
      <Link href="/rankings" className={`${btn.ghost} -ml-2.5`}><ArrowLeft className="size-4" /> Rankings</Link>
      <div className="mt-4">
        <Suspense fallback={<Skeleton className="h-56" />}>
          <Guest params={params} />
        </Suspense>
      </div>
    </>
  );
}

async function Guest({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const [guestQ, epsQ, topicsQ] = await Promise.all([
    db().execute({ sql: "select id, canonical_name name, company, role, aliases from guests where id = ?", args: [id] }),
    db().execute({
      sql: `select e.id, e.title, e.published_at, e.view_count, e.kind, s.name show, a.evidence
            from appearances a join episodes e on e.id = a.episode_id join shows s on s.id = e.show_id
            where a.guest_id = ? order by e.published_at desc`,
      args: [id],
    }),
    db().execute({
      sql: `select t.label, count(distinct e.id) c from appearances a join episodes e on e.id = a.episode_id
              join episode_topics et on et.episode_id = e.id join topics t on t.id = et.topic_id
            where a.guest_id = ? and t.slug != 'other' group by t.id order by c desc, t.label limit 6`,
      args: [id],
    }),
  ]);
  const r = guestQ.rows[0];
  if (!r) notFound();
  const g: GuestBasics = { id, name: String(r.name), company: (r.company as string) || null, role: (r.role as string) || null };
  const eps = epsQ.rows.map((e) => ({
    id: String(e.id), title: String(e.title), date: String(e.published_at), views: e.view_count as number | null,
    show: String(e.show), evidence: e.evidence as string | null, full: e.kind === "full",
  }));
  const shows = [...new Set(eps.map((e) => e.show))];
  const views = eps.reduce((s, e) => s + (e.views ?? 0), 0);
  const aliases = (JSON.parse(String(r.aliases ?? "[]")) as string[]).filter((a) => a !== g.name);
  const initials = g.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  return (
    <>
      <header className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <span className="grid size-16 shrink-0 place-items-center rounded-2xl font-serif text-2xl text-white"
          style={{ background: showColor(g.name) }} aria-hidden>{initials}</span>
        <div className="min-w-0 flex-1">
          <h1 className="font-serif text-[2.4rem] leading-none tracking-[-0.01em] text-ink">{g.name}</h1>
          {(g.role || g.company) && <p className="mt-2 text-[0.95rem] text-ink-2">{[g.role, g.company].filter(Boolean).join(" at ")}</p>}
          {aliases.length > 0 && <p className="mt-1 text-xs text-ink-3">Also written as {aliases.join(", ")}</p>}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {topicsQ.rows.map((t) => <Pill key={String(t.label)}>{String(t.label)}</Pill>)}
          </div>
        </div>
        <form action={refreshGuest} className="shrink-0">
          <input type="hidden" name="id" value={id} />
          <SubmitButton variant="secondary" pending="Refreshing…"><RefreshCw className="size-4" /> Refresh outside info</SubmitButton>
        </form>
      </header>

      <Suspense fallback={<OutsideSkeleton />}>
        <Outside g={g} eps={eps.length} shows={shows} views={views} lastSeen={eps[0]?.date ?? null} />
      </Suspense>

      <Section title="On your radar" description={`${plural(eps.length, "episode")} across ${plural(shows.length, "monitored show")}, with the line that identified them.`}>
        <Panel>
          <ul className="divide-y divide-line">
            {eps.map((e) => (
              <li key={e.id} className="px-5 py-3.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <ShowName name={e.show} className="text-xs text-ink-3" />
                  <Link href={`/episodes/${e.id}`} className="min-w-0 flex-1 font-medium text-ink hover:underline" title={e.title}>{headline(e.title)}</Link>
                  {e.views !== null && <span className="num inline-flex items-center gap-1 text-xs text-ink-3"><Eye className="size-3.5" /> {compact(e.views)}</span>}
                  <span className="num text-xs text-ink-3">{fmtDate(e.date)}</span>
                </div>
                {e.evidence && (
                  <p className="mt-1.5 flex gap-2 text-sm italic text-ink-2"><Quote className="mt-0.5 size-3.5 shrink-0 text-ink-3" />{e.evidence}</p>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      </Section>

      <Section title="Find them" description="Search links to reach out. These open the search pages, nothing is looked up for you.">
        <div className="flex flex-wrap gap-2">
          {[
            ["LinkedIn", `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent([g.name, g.company].filter(Boolean).join(" "))}`],
            ["X / Twitter", `https://x.com/search?q=${encodeURIComponent(`"${g.name}"`)}&f=user`],
            ["Google", `https://www.google.com/search?q=${encodeURIComponent([`"${g.name}"`, g.company].filter(Boolean).join(" "))}`],
            ["YouTube", `https://www.youtube.com/results?search_query=${encodeURIComponent(`${g.name} podcast`)}`],
          ].map(([label, href]) => (
            <a key={label} href={href} target="_blank" rel="noreferrer" className={btn.secondary}>
              <Search className="size-4" /> {label} <ArrowUpRight className="size-3.5 text-ink-3" />
            </a>
          ))}
        </div>
      </Section>
    </>
  );
}

async function Outside({ g, eps, shows, views, lastSeen }: {
  g: GuestBasics; eps: number; shows: string[]; views: number; lastSeen: string | null;
}) {
  const { wiki, podcasts, news } = await enrichGuest(g);
  const pods = podcasts.data, w = wiki.data, headlines = news.data ?? [];
  const recentNews = headlines.filter((h) => h.date && withinDays(h.date, 30)).length;

  // Plain-language reasons, each tied to a number shown below.
  const signals: { icon: typeof Sparkles; tone: "good" | "warn" | "neutral"; text: React.ReactNode }[] = [];
  if (shows.length >= 2) signals.push({ icon: UsersRound, tone: "warn", text: <>Already on {shows.length} of your shows. Others are booking them now.</> });
  else signals.push({ icon: Sparkles, tone: "good", text: <>Seen on just one of your shows ({shows[0]}). Few of your peers have had them yet.</> });
  if (pods) {
    if (pods.last90 >= 5) signals.push({ icon: Mic, tone: "warn", text: <>Busy podcast circuit: {pods.last90} episodes elsewhere named them in the last 90 days.</> });
    else if (pods.total < 5) signals.push({ icon: Mic, tone: "good", text: <>Rarely on podcasts: only {plural(pods.total, "episode")} elsewhere name them.</> });
    else signals.push({ icon: Mic, tone: "neutral", text: <>{pods.total}{pods.capped ? "+" : ""} podcast episodes elsewhere name them, {pods.last90} in the last 90 days.</> });
    if (pods.ownShow) signals.push({ icon: Mic, tone: "neutral", text: <>Hosts their own podcast, <b className="font-medium">{pods.ownShow}</b>. Comfortable on mic.</> });
  }
  if (recentNews) signals.push({ icon: Newspaper, tone: "good", text: <>In the news: {plural(recentNews, "headline")} in the last 30 days. A timely hook for the conversation.</> });
  if (views) signals.push({ icon: Eye, tone: "neutral", text: <>Their episodes on your radar have {compact(views)} YouTube views.</> });

  const toneClass = { good: "bg-good-soft text-good", warn: "bg-warn-soft text-warn", neutral: "bg-surface-2 text-ink-2" };

  return (
    <>
      <div className="mt-8 grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <Panel className="p-5">
          <h2 className="text-sm font-semibold text-ink">Why book them</h2>
          <ul className="mt-3 space-y-2.5">
            {signals.map((s, i) => (
              <li key={i} className="flex gap-3 text-sm leading-relaxed text-ink-2">
                <span className={`grid size-6 shrink-0 place-items-center rounded-md ${toneClass[s.tone]}`}><s.icon className="size-3.5" /></span>
                <span>{s.text}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel className="p-5">
          <h2 className="text-sm font-semibold text-ink">About</h2>
          {w ? (
            <div className="mt-3 flex gap-4">
              {w.image && (
                <Image src={w.image} alt={w.title} width={72} height={90} className="h-[90px] w-[72px] shrink-0 rounded-lg object-cover" />
              )}
              <div className="min-w-0 text-sm leading-relaxed text-ink-2">
                {w.description && <p className="font-medium text-ink">{w.description}</p>}
                <p className="mt-1 line-clamp-6">{w.extract}</p>
                <a href={w.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                  Wikipedia <ArrowUpRight className="size-3" />
                </a>
                {!w.confirmed && (
                  <p className="mt-2 flex items-start gap-1.5 text-xs text-warn"><CircleAlert className="mt-px size-3.5 shrink-0" /> Matched by name only. Check it&apos;s the same person.</p>
                )}
              </div>
            </div>
          ) : (
            <div className="mt-3 text-sm leading-relaxed text-ink-2">
              <p>{[g.role, g.company].filter(Boolean).join(" at ") || "No role or company was stated in the episodes."}</p>
              <p className="mt-2 text-xs text-ink-3">{wiki.error ? `Wikipedia lookup failed: ${wiki.error}` : "No Wikipedia article. Use the search links below to learn more."}</p>
            </div>
          )}
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel className="flex flex-col">
          <div className="flex items-baseline justify-between gap-3 px-5 pt-4">
            <h2 className="text-sm font-semibold text-ink">Elsewhere on podcasts</h2>
            {pods && <span className="num text-xs text-ink-3">{pods.total}{pods.capped ? "+" : ""} found · {pods.last90} in 90 days</span>}
          </div>
          {pods?.items.length ? (
            <ul className="mt-2 divide-y divide-line">
              {pods.items.map((p, i) => (
                <li key={i} className="px-5 py-2.5 text-sm">
                  <p className="flex items-baseline gap-2 text-xs text-ink-3">
                    <span className="truncate">{p.feed}</span>
                    {pods.ownShow === p.feed && <Pill tone="accent">Their show</Pill>}
                    <span className="num ml-auto shrink-0">{fmtDate(p.date)}</span>
                  </p>
                  {p.url ? <a href={p.url} target="_blank" rel="noreferrer" className="mt-0.5 line-clamp-2 text-ink hover:underline">{p.title}</a>
                    : <p className="mt-0.5 line-clamp-2 text-ink">{p.title}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 py-4 text-sm text-ink-3">{podcasts.error ? `Podcast Index lookup failed: ${podcasts.error}` : "No other podcast appearances found in Podcast Index."}</p>
          )}
          <p className="mt-auto border-t border-line px-5 py-2 text-xs text-ink-3">Podcast Index episodes that name them, as guest or topic. Your own shows are left out.</p>
        </Panel>

        <Panel className="flex flex-col">
          <div className="flex items-baseline justify-between gap-3 px-5 pt-4">
            <h2 className="text-sm font-semibold text-ink">In the news</h2>
            <span className="text-xs text-ink-3">Last 90 days</span>
          </div>
          {headlines.length ? (
            <ul className="mt-2 divide-y divide-line">
              {headlines.map((h, i) => (
                <li key={i} className="px-5 py-2.5 text-sm">
                  <a href={h.url} target="_blank" rel="noreferrer" className="line-clamp-2 text-ink hover:underline">{h.title}</a>
                  <p className="mt-0.5 text-xs text-ink-3">{[h.source, h.date && fmtDate(h.date)].filter(Boolean).join(" · ")}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 py-4 text-sm text-ink-3">{news.error ? `News lookup failed: ${news.error}` : "No headlines naming them in the last 90 days."}</p>
          )}
          <p className="mt-auto border-t border-line px-5 py-2 text-xs text-ink-3">Google News search for the exact name.</p>
        </Panel>
      </div>

      <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-3">
        <BadgeCheck className="size-3.5" />
        Outside info checked {ago(podcasts.fetchedAt ?? wiki.fetchedAt)}, refreshed weekly. {n(eps)} radar {eps === 1 ? "episode" : "episodes"}{shows.length ? <>, last {lastSeen ? fmtDate(lastSeen) : "–"}</> : null}.
      </p>
    </>
  );
}

function OutsideSkeleton() {
  return (
    <div className="mt-8 space-y-4" aria-busy="true" aria-label="Looking up outside info">
      <div className="grid gap-4 lg:grid-cols-2"><Skeleton className="h-40" /><Skeleton className="h-40" /></div>
      <div className="grid gap-4 lg:grid-cols-2"><Skeleton className="h-64" /><Skeleton className="h-64" /></div>
    </div>
  );
}
