import { Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { connection } from "next/server";
import {
  ArrowUpRight, Eye, Flame, Heart, Megaphone, MessageCircle, Play, Sparkles, TrendingDown, TrendingUp, UserRoundSearch,
} from "lucide-react";
import { db } from "@/lib/db";
import { computeScores, type GuestRank, type SponsorRank, type TopicRank } from "@/lib/score";
import { refreshVideoStatsIfStale } from "@/lib/stats";
import { AddChannelForm, RemoveShowButton } from "@/components/channels";
import {
  Panel, PageSkeleton, Pill, Section, ShowName, TextLink, ago, btn, duration, fmtDate, n, showColor, weekLabel,
} from "@/components/ui";

const WEEKS = 8;
const DAY = 86_400_000;
const daysAgoIso = (d: number) => new Date(Date.now() - d * DAY).toISOString();
const compact = (v: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);
const plural = (c: number, one: string, many = `${one}s`) => `${c} ${c === 1 ? one : many}`;
// YouTube titles carry "| Guest | EP123 Host" tails; the first segment reads as the headline.
const headline = (t: string) => t.split(" | ")[0].trim() || t;

export default function Home() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Overview />
    </Suspense>
  );
}

type Video = {
  id: string; title: string; publishedAt: string; views: number; likes: number | null; comments: number | null;
  videoId: string; seconds: number | null; showId: string; show: string;
};

async function Overview() {
  await connection();
  const [scores] = await Promise.all([computeScores(), refreshVideoStatsIfStale()]);
  const [shows, weekly, totals, entities, runs, pool] = await Promise.all([
    db().execute({
      sql: `select s.id, s.name, s.active, s.host_names, s.youtube_channel_id, s.rss_url,
              count(e.id) items,
              coalesce(sum(e.kind = 'full' and e.published_at >= ?), 0) full_30d,
              max(case when e.kind = 'full' then e.published_at end) latest_full
            from shows s left join episodes e on e.show_id = s.id group by s.id order by s.active desc, s.name`,
      args: [daysAgoIso(30)],
    }),
    db().execute({
      sql: `select show_id, cast((julianday('now') - julianday(published_at)) / 7 as integer) wk, count(*) c
            from episodes where kind = 'full' and published_at >= ? group by 1, 2`,
      args: [daysAgoIso(WEEKS * 7)],
    }),
    db().execute({
      sql: `select count(*) items, coalesce(sum(kind = 'full'), 0) full_eps,
              coalesce(sum(kind = 'full' and status = 'extracted'), 0) extracted,
              coalesce(sum(kind = 'full' and status = 'pending_extraction'), 0) pending,
              coalesce(sum(case when kind = 'full' and status = 'extracted' then duration_seconds end), 0) secs,
              coalesce(sum(case when kind = 'full' and published_at >= ? then view_count end), 0) views_30d
            from episodes`,
      args: [daysAgoIso(30)],
    }),
    db().execute(`select (select count(distinct guest_id) from appearances) guests,
                    (select count(distinct brand_id) from brand_mentions) brands,
                    (select count(*) from brand_mentions where mention_type in ('paid_read', 'sponsor_disclosure')) reads,
                    (select count(distinct topic_id) from episode_topics) topics`),
    db().execute(`select (select started_at from ingest_runs order by started_at desc limit 1) ingested,
                    (select errors from ingest_runs order by started_at desc limit 1) ingest_errors,
                    (select finished_at from extract_runs order by started_at desc limit 1) extracted`),
    db().execute({
      sql: `select e.id, e.title, e.published_at, e.view_count, e.like_count, e.comment_count, e.youtube_video_id,
              e.duration_seconds, e.show_id, s.name show
            from episodes e join shows s on s.id = e.show_id
            where e.kind = 'full' and e.view_count is not null and e.published_at >= ?
            order by e.view_count desc`,
      args: [daysAgoIso(45)],
    }),
  ]);

  const t = totals.rows[0], ent = entities.rows[0], run = runs.rows[0];
  const runErrors = run?.ingest_errors ? (JSON.parse(String(run.ingest_errors)) as string[]).length : 0;

  // Breakout: the most-watched full episode of the last 14 days, widening to 30 or 45 if nothing qualifies.
  const videos: Video[] = pool.rows.map((r) => ({
    id: String(r.id), title: String(r.title), publishedAt: String(r.published_at), views: Number(r.view_count),
    likes: r.like_count as number | null, comments: r.comment_count as number | null, videoId: String(r.youtube_video_id),
    seconds: r.duration_seconds as number | null, showId: String(r.show_id), show: String(r.show),
  }));
  const now = Date.parse(scores.asOf);
  const windowDays = [14, 30, 45].find((d) => videos.some((v) => Date.parse(v.publishedAt) >= now - d * DAY)) ?? 45;
  const inWindow = videos.filter((v) => Date.parse(v.publishedAt) >= now - windowDays * DAY);
  const breakout = inWindow[0];
  const showViews = (id: string) => videos.filter((v) => v.showId === id).map((v) => v.views).sort((a, b) => a - b);
  const median = (xs: number[]) => (xs.length ? xs[Math.floor((xs.length - 1) / 2)] : 0);
  const breakoutGuests = breakout
    ? (await db().execute({
        sql: "select g.canonical_name name from appearances a join guests g on g.id = a.guest_id where a.episode_id = ?",
        args: [breakout.id],
      })).rows.map((r) => String(r.name))
    : [];

  const guests = [...scores.mediaRounds, ...scores.earlyGuests].slice(0, 2);
  const topics = scores.topics.slice(0, 5);
  const sponsors = scores.sponsors.slice(0, 2);

  const bars = new Map<string, number[]>();
  for (const r of weekly.rows) {
    const arr = bars.get(String(r.show_id)) ?? Array(WEEKS).fill(0);
    const wk = Number(r.wk);
    if (wk >= 0 && wk < WEEKS) arr[WEEKS - 1 - wk] = Number(r.c);
    bars.set(String(r.show_id), arr);
  }
  const peak = Math.max(1, ...[...bars.values()].flat());
  const activeShows = shows.rows.filter((s) => s.active === 1).length;

  return (
    <>
      <Hero
        breakout={breakout} breakoutGuests={breakoutGuests} guest={scores.mediaRounds[0]}
        topic={scores.topics.find((x) => x.trend === "rising" || x.trend === "new") ?? scores.topics[0]}
        sponsor={sponsors[0]} extracted={Number(t.extracted)} shows={activeShows}
      />

      {runErrors > 0 && (
        <Link href="/admin/runs" className="mt-4 block rounded-lg bg-bad-soft px-4 py-2 text-sm text-bad hover:underline">
          The last collection run reported {plural(runErrors, "error")}. See details.
        </Link>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <GuestsCard guests={guests} rounds={scores.mediaRounds.length} />
        <TopicsCard topics={topics} />
        <SponsorsCard sponsors={sponsors} total={scores.sponsors.length} windowDays={scores.weights.sponsorWindowDays} />
      </div>

      <Section title="Breakout episode" description={`The single most-watched full episode on YouTube from the last ${windowDays} days.`}>
        {breakout ? (
          <Breakout v={breakout} now={now} guests={breakoutGuests} median={median(showViews(breakout.showId))}
            runnersUp={inWindow.slice(1, 4)} />
        ) : (
          <Panel className="px-5 py-6 text-sm text-ink-3">No YouTube view counts yet. They are fetched after each collection run.</Panel>
        )}
      </Section>

      <Section title="By the numbers" description="Everything the radar has collected and read so far.">
        <Panel className="overflow-hidden">
          <dl className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
            <Metric label="Items scanned" value={n(t.items)} hint="videos, clips and RSS episodes" />
            <Metric label="Episodes read by AI" value={n(t.extracted)} hint={Number(t.pending) ? `${n(t.pending)} more in queue` : `of ${n(t.full_eps)} full episodes`} />
            <Metric label="Hours analysed" value={n(Math.round(Number(t.secs) / 3600))} hint="of long-form conversation" />
            <Metric label="Guests identified" value={n(ent.guests)} hint={`across ${plural(activeShows, "show")}`} />
            <Metric label="Sponsor reads" value={n(ent.reads)} hint={`${n(ent.brands)} brands mentioned`} />
            <Metric label="Views tracked" value={compact(Number(t.views_30d))} hint="YouTube, last 30 days" />
          </dl>
          <p className="flex flex-wrap gap-x-4 gap-y-1 bg-surface-2/50 px-5 py-2.5 text-xs text-ink-3">
            <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-good" /> Collected {ago(run?.ingested as string | null)}</span>
            <span>AI extraction {ago(run?.extracted as string | null)}</span>
            <span>{n(ent.topics)} topics tracked</span>
            <Link href="/admin/runs" className="ml-auto font-medium text-accent hover:underline">Runs and logs</Link>
          </p>
        </Panel>
      </Section>

      <Section
        title="Your radar"
        description="Channels being watched. Paste a YouTube link to add one; its recent uploads are collected straight away."
        action={<TextLink href="/admin/shows">Advanced settings</TextLink>}
      >
        <Panel className="overflow-hidden">
          <div className="border-b border-line bg-surface-2/50 px-5 py-4"><AddChannelForm /></div>
          <div className="hidden grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_7rem_2rem] gap-4 border-b border-line px-5 py-2 text-xs font-medium text-ink-3 md:grid">
            <span>Channel</span><span>Full episodes, last {WEEKS} weeks</span><span className="text-right">Last 30 days</span><span />
          </div>
          <ul className="divide-y divide-line">
            {shows.rows.map((s) => {
              const id = String(s.id), name = String(s.name), active = s.active === 1;
              const full30 = Number(s.full_30d);
              const series = bars.get(id) ?? Array(WEEKS).fill(0);
              const hosts = (JSON.parse(String(s.host_names ?? "[]")) as string[]).join(", ");
              const sources = [s.youtube_channel_id && "YouTube", s.rss_url && "RSS"].filter(Boolean).join(" + ");
              return (
                <li key={id}
                  className={`grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-2 px-5 py-3 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_7rem_2rem] md:gap-x-4 ${active ? "" : "bg-surface-2/40"}`}>
                  <div className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <Link href={`/episodes?show=${id}`} className="flex min-w-0 font-medium text-ink hover:underline"><ShowName name={name} /></Link>
                      {s.youtube_channel_id ? (
                        <a href={`https://www.youtube.com/channel/${s.youtube_channel_id}`} target="_blank" rel="noreferrer"
                          className="shrink-0 text-ink-3 hover:text-ink" aria-label={`${name} on YouTube`}>
                          <ArrowUpRight className="size-3.5" />
                        </a>
                      ) : null}
                    </span>
                    <p className="ml-4 truncate text-xs text-ink-3">{[hosts, sources || "No source connected"].filter(Boolean).join(" · ")}</p>
                  </div>
                  <div className="order-last col-span-3 md:order-none md:col-span-1">
                    {active ? (
                      <div className="flex h-7 items-end gap-1" role="img"
                        aria-label={`Full episodes per week, oldest first: ${series.join(", ")}`}>
                        {series.map((c, i) => (
                          <span key={i} className="flex-1 rounded-[3px]"
                            style={{
                              height: c ? `${Math.max(18, (c / peak) * 100)}%` : "3px",
                              background: c ? showColor(name) : "var(--bar-empty)",
                              opacity: c ? 0.45 + 0.55 * (i / (WEEKS - 1)) : 1,
                            }} />
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-ink-3">Paused</span>
                    )}
                  </div>
                  <div className="text-right">
                    {!active ? <Pill>Paused</Pill>
                      : full30 === 0 ? <Pill tone="warn" dot>Quiet</Pill>
                      : <span className="num text-sm text-ink"><b className="font-semibold">{full30}</b> <span className="text-ink-3">{full30 === 1 ? "episode" : "episodes"}</span></span>}
                  </div>
                  <RemoveShowButton id={id} name={name} episodes={Number(s.items)} />
                </li>
              );
            })}
            {!shows.rows.length && <li className="px-5 py-6 text-sm text-ink-3">Nothing on the radar yet. Paste a YouTube channel above.</li>}
          </ul>
        </Panel>
      </Section>
    </>
  );
}

// ---------- hero ----------

function Hero({ breakout, breakoutGuests, guest, topic, sponsor, extracted, shows }: {
  breakout?: Video; breakoutGuests: string[]; guest?: GuestRank; topic?: TopicRank; sponsor?: SponsorRank;
  extracted: number; shows: number;
}) {
  const lines: React.ReactNode[] = [];
  if (guest) lines.push(<><Em>{guest.name}</Em> is doing the rounds, on {plural(guest.shows, "show")} this month</>);
  if (breakout) {
    const who = breakoutGuests[0] ?? headline(breakout.title);
    lines.push(<><Em>{who}</Em> on {breakout.show} pulled <Em>{compact(breakout.views)} views</Em></>);
  }
  if (topic) {
    lines.push(topic.trend === "falling"
      ? <><Em>{topic.label}</Em> leads the conversation</>
      : <><Em>{topic.label}</Em> is {topic.trend === "new" ? "breaking out" : "heating up"}</>);
  }
  if (sponsor) lines.push(<><Em>{sponsor.name}</Em> is buying reads on {plural(sponsor.shows, "show")}</>);

  return (
    <header className="relative overflow-hidden rounded-2xl border border-line bg-surface px-6 pb-7 pt-6 shadow-[0_1px_2px_rgb(16_24_40/0.04)] sm:px-9 sm:pb-9 sm:pt-8">
      <RadarRings />
      <div className="relative flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-ink-3">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-accent-soft-ink">
          <span className="relative flex size-1.5"><span className="absolute inset-0 animate-ping rounded-full bg-current opacity-60 motion-reduce:hidden" /><span className="size-1.5 rounded-full bg-current" /></span>
          Monday briefing
        </span>
        <span>Week of {weekLabel()}</span>
        <span className="hidden sm:inline">· {n(extracted)} episodes from {plural(shows, "show")}</span>
      </div>
      {lines.length ? (
        <h1 className="relative mt-5 max-w-3xl font-serif text-[1.85rem] leading-[1.18] tracking-[-0.01em] text-ink-2 sm:text-[2.45rem]">
          {lines.map((l, i) => (
            <span key={i}>{l}{i < lines.length - 2 ? ". " : i === lines.length - 2 ? ", and " : "."}</span>
          ))}
        </h1>
      ) : (
        <h1 className="relative mt-5 max-w-2xl font-serif text-[1.85rem] leading-tight text-ink sm:text-[2.45rem]">
          The radar is listening. Highlights appear once episodes are read.
        </h1>
      )}
      <div className="relative mt-6 flex flex-wrap gap-2">
        <Link href="/rankings" className={btn.primary}>See full rankings</Link>
        <Link href="/briefs" className={btn.secondary}>Briefs</Link>
      </div>
    </header>
  );
}

function Em({ children }: { children: React.ReactNode }) {
  return <span className="text-ink">{children}</span>;
}

function RadarRings() {
  return (
    <svg viewBox="0 0 400 400" aria-hidden
      className="pointer-events-none absolute -right-24 -top-28 size-[26rem] text-ink opacity-[0.07] sm:-right-16">
      {[60, 110, 160, 198].map((r) => <circle key={r} cx="200" cy="200" r={r} fill="none" stroke="currentColor" strokeWidth="1.5" />)}
      <path d="M200 200 L340 60" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <circle cx="268" cy="248" r="7" fill="currentColor" />
      <circle cx="150" cy="120" r="4" fill="currentColor" />
    </svg>
  );
}

// ---------- highlight cards ----------

function Card({ icon: Icon, eyebrow, title, href, children }: {
  icon: typeof Flame; eyebrow: string; title: string; href: string; children: React.ReactNode;
}) {
  return (
    <Panel className="flex min-w-0 flex-col">
      <div className="flex items-center gap-2 px-5 pt-4">
        <span className="grid size-7 place-items-center rounded-lg bg-accent-soft text-accent-soft-ink"><Icon className="size-4" strokeWidth={1.9} /></span>
        <div className="leading-tight">
          <p className="text-[0.7rem] font-medium uppercase tracking-[0.08em] text-ink-3">{eyebrow}</p>
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
        </div>
      </div>
      <div className="flex-1 px-5 pb-2 pt-3">{children}</div>
      <Link href={href} className="flex items-center justify-between border-t border-line px-5 py-2.5 text-sm font-medium text-accent hover:bg-surface-2/50">
        See all <ArrowUpRight className="size-4" />
      </Link>
    </Panel>
  );
}

function ShowDots({ names }: { names: string[] }) {
  return (
    <span className="inline-flex -space-x-1" aria-label={names.join(", ")} title={names.join(", ")}>
      {names.map((s) => <span key={s} className="size-3 rounded-full ring-2 ring-surface" style={{ background: showColor(s) }} />)}
    </span>
  );
}

const uniq = (xs: string[]) => [...new Set(xs)];

function GuestsCard({ guests, rounds }: { guests: GuestRank[]; rounds: number }) {
  return (
    <Card icon={UserRoundSearch} eyebrow="Who to book" title="Top guests" href="/rankings">
      {guests.length ? (
        <ol className="space-y-4">
          {guests.map((g, i) => {
            const showNames = uniq(g.episodes.map((e) => e.show));
            const latest = g.episodes[0];
            return (
              <li key={g.id} className="flex gap-3">
                <span className="font-serif text-3xl leading-none text-ink-3">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <Link href={`/guests/${g.id}`} className="block truncate font-semibold text-ink hover:underline">{g.name}</Link>
                  {(g.role || g.company) && <p className="truncate text-xs text-ink-3">{[g.role, g.company].filter(Boolean).join(", ")}</p>}
                  <p className="mt-1.5 flex items-center gap-2 text-xs text-ink-2">
                    <ShowDots names={showNames} />
                    {g.shows >= 2 ? <>{plural(g.shows, "show")} · {plural(g.appearances, "episode")}</> : <>First podcast seen · {fmtDate(g.lastSeen)}</>}
                  </p>
                  {latest && (
                    <Link href={`/episodes/${latest.id}`} className="mt-1 block truncate text-xs text-ink-3 hover:text-ink hover:underline">
                      Latest: {headline(latest.title)}
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-sm text-ink-3">No guests in the last 30 days yet.</p>
      )}
      {guests.length > 0 && rounds < 2 && (
        <p className="mt-3 text-xs text-ink-3">{rounds ? "Only one guest is on 2+ shows; the next is a first-time guest." : "Nobody is on 2+ shows yet, so these are first-time guests."}</p>
      )}
    </Card>
  );
}

function TopicsCard({ topics }: { topics: TopicRank[] }) {
  const max = Math.max(1, ...topics.map((x) => Math.max(x.thisWeek, x.priorAvg)));
  return (
    <Card icon={Flame} eyebrow="What to cover" title="Topics this week" href="/rankings">
      {topics.length ? (
        <ul className="space-y-3">
          {topics.map((x) => {
            const delta = Math.round((x.thisWeek - x.priorAvg) * 10) / 10;
            return (
              <li key={x.slug}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate text-ink">{x.label}</span>
                  <span className={`num inline-flex shrink-0 items-center gap-1 text-xs font-medium ${x.trend === "falling" ? "text-bad" : x.trend === "steady" ? "text-ink-3" : "text-good"}`}>
                    {x.trend === "falling" ? <TrendingDown className="size-3" /> : x.trend === "steady" ? null : x.trend === "new" ? <Sparkles className="size-3" /> : <TrendingUp className="size-3" />}
                    {x.trend === "new" ? "New" : `${delta > 0 ? "+" : ""}${delta}`}
                  </span>
                </div>
                <div className="relative mt-1.5 h-1.5 rounded-full bg-bar-empty"
                  role="img" aria-label={`${x.thisWeek} episodes in the last 7 days, ${x.priorAvg} in an average week before`}>
                  <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${(x.thisWeek / max) * 100}%` }} />
                  {x.priorAvg > 0 && <span className="absolute -inset-y-0.5 w-0.5 rounded-full bg-ink-2" style={{ left: `calc(${(x.priorAvg / max) * 100}% - 1px)` }} />}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-ink-3">Not enough tagged episodes in the last 5 weeks.</p>
      )}
      {topics.length > 0 && (
        <p className="mt-3 flex items-center gap-3 text-[0.7rem] text-ink-3">
          <span className="inline-flex items-center gap-1"><span className="h-1.5 w-3 rounded-full bg-accent" /> Last 7 days</span>
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-0.5 rounded-full bg-ink-2" /> Avg week before</span>
        </p>
      )}
    </Card>
  );
}

function SponsorsCard({ sponsors, total, windowDays }: { sponsors: SponsorRank[]; total: number; windowDays: number }) {
  return (
    <Card icon={Megaphone} eyebrow="Who to pitch" title="Top sponsors" href="/rankings">
      {sponsors.length ? (
        <ol className="space-y-4">
          {sponsors.map((b, i) => {
            const showNames = uniq(b.episodes.map((e) => e.show));
            return (
              <li key={b.id} className="flex gap-3">
                <span className="font-serif text-3xl leading-none text-ink-3">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-ink">{b.name}</p>
                  <p className="mt-1.5 flex items-center gap-2 text-xs text-ink-2">
                    <ShowDots names={showNames} />
                    {plural(b.shows, "show")} · {plural(b.placements, "placement")}
                  </p>
                  <p className="mt-1 text-xs text-ink-3">Last read {fmtDate(b.lastSeen)} on {b.episodes[0]?.show ?? "–"}</p>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-sm text-ink-3">No paid reads in the last {windowDays} days.</p>
      )}
      {total > 2 && <p className="mt-3 text-xs text-ink-3">{total - 2} more brands paid for placements in the last {windowDays} days.</p>}
    </Card>
  );
}

// ---------- breakout ----------

function Breakout({ v, now, guests, median, runnersUp }: {
  v: Video; now: number; guests: string[]; median: number; runnersUp: Video[];
}) {
  const days = Math.max(1, (now - Date.parse(v.publishedAt)) / DAY);
  const lift = median ? v.views / median : 0;
  const engagement = v.likes !== null ? ((v.likes + (v.comments ?? 0)) / Math.max(1, v.views)) * 100 : null;
  const yt = `https://www.youtube.com/watch?v=${v.videoId}`;
  const top = Math.max(v.views, ...runnersUp.map((r) => r.views));

  return (
    <div className="overflow-hidden rounded-2xl bg-ink text-bg shadow-[0_8px_30px_rgb(16_24_40/0.12)]">
      <div className="grid gap-0 md:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <a href={yt} target="_blank" rel="noreferrer" className="group relative block aspect-video overflow-hidden bg-black md:aspect-auto md:min-h-full">
          <Image src={`https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`} alt="" fill sizes="(min-width: 768px) 560px, 100vw"
            className="object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
          <span className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/0 to-black/0" />
          <span className="absolute left-4 top-4 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white backdrop-blur">
            <Flame className="size-3.5 text-[#ffb35c]" /> Breakout
          </span>
          <span className="absolute bottom-4 left-4 grid size-12 place-items-center rounded-full bg-white/95 text-black shadow-lg transition-transform group-hover:scale-110">
            <Play className="ml-0.5 size-5 fill-current" />
          </span>
          {v.seconds ? <span className="num absolute bottom-4 right-4 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white">{duration(v.seconds)}</span> : null}
        </a>

        <div className="flex flex-col p-6 sm:p-7">
          <p className="flex items-center gap-2 text-xs opacity-70">
            <span className="size-2 rounded-full" style={{ background: showColor(v.show) }} /> {v.show} · {fmtDate(v.publishedAt)}
          </p>
          <Link href={`/episodes/${v.id}`} className="mt-2 text-xl font-semibold leading-snug tracking-[-0.01em] hover:underline" title={v.title}>
            {headline(v.title)}
          </Link>
          {guests.length > 0 && <p className="mt-1.5 text-sm opacity-70">With {guests.join(", ")}</p>}

          <div className="mt-6 flex items-end gap-3">
            <span className="num font-serif text-6xl leading-none">{compact(v.views)}</span>
            <span className="pb-1 text-sm opacity-70">views</span>
          </div>
          {lift >= 1.2 && (
            <p className="mt-2 inline-flex w-fit items-center gap-1.5 rounded-full bg-[#ffb35c]/20 px-2.5 py-1 text-xs font-medium text-[#ffcf96]">
              <TrendingUp className="size-3.5" /> {lift >= 10 ? Math.round(lift) : lift.toFixed(1)}× a typical {v.show} episode
            </p>
          )}

          <dl className="mt-6 grid grid-cols-3 gap-3 border-t border-bg/15 pt-4 text-sm">
            <Stat icon={Eye} label="Views a day" value={compact(v.views / days)} />
            <Stat icon={Heart} label="Likes" value={v.likes === null ? "–" : compact(v.likes)} />
            <Stat icon={MessageCircle} label="Comments" value={v.comments === null ? "–" : compact(v.comments)} />
          </dl>
          {engagement !== null && <p className="mt-3 text-xs opacity-60">{engagement.toFixed(1)}% of viewers liked or commented.</p>}
        </div>
      </div>

      {runnersUp.length > 0 && (
        <div className="border-t border-bg/15 px-6 py-4 sm:px-7">
          <p className="text-xs font-medium uppercase tracking-[0.08em] opacity-60">Also pulling views</p>
          <ul className="mt-2 space-y-2">
            {runnersUp.map((r) => (
              <li key={r.id} className="grid grid-cols-[minmax(0,1fr)_4.5rem] items-center gap-3 text-sm sm:grid-cols-[minmax(0,1fr)_9rem_4.5rem]">
                <Link href={`/episodes/${r.id}`} className="min-w-0 truncate opacity-85 hover:underline hover:opacity-100" title={r.title}>
                  <span className="mr-2 inline-block size-2 rounded-full align-middle" style={{ background: showColor(r.show) }} />
                  {headline(r.title)}
                </Link>
                <span className="hidden h-1.5 rounded-full bg-bg/15 sm:block">
                  <span className="block h-full rounded-full bg-bg/70" style={{ width: `${(r.views / top) * 100}%` }} />
                </span>
                <span className="num text-right opacity-80">{compact(r.views)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof Eye; label: string; value: string }) {
  return (
    <div>
      <dt className="flex items-center gap-1 text-xs opacity-60"><Icon className="size-3.5" /> {label}</dt>
      <dd className="num mt-0.5 text-base font-semibold">{value}</dd>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="bg-surface px-5 py-4">
      <dt className="text-xs font-medium text-ink-3">{label}</dt>
      <dd className="num mt-1 font-serif text-[2.1rem] leading-none text-ink">{value}</dd>
      <dd className="mt-1.5 text-xs text-ink-3">{hint}</dd>
    </div>
  );
}
