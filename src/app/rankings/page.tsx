import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { ChevronRight, GitMerge, Megaphone, Sparkles, TrendingDown, TrendingUp, UserRoundSearch } from "lucide-react";
import { db } from "@/lib/db";
import { getBlurbs } from "@/lib/blurbs";
import type { Row } from "@libsql/client";
import { computeScores, type EpisodeRef, type GuestRank } from "@/lib/score";
import { EmptyState, PageHeader, PageSkeleton, Panel, Pill, Section, ShowName, TextLink, ago, fmtDate, fmtDateTime } from "@/components/ui";

export const metadata = { title: "Rankings" };

type Tab = "guests" | "topics" | "sponsors";
type SP = Promise<{ tab?: string }>;

export default function RankingsPage({ searchParams }: { searchParams: SP }) {
  return (
    <>
      <PageHeader
        title="Rankings"
        description="Live scores from every extracted episode, worked out with plain SQL each time this page loads. Monday's brief is built from these."
      />
      <Suspense fallback={<PageSkeleton />}>
        <Rankings searchParams={searchParams} />
      </Suspense>
    </>
  );
}

const EARLY_SHOWN = 12;

async function Rankings({ searchParams }: { searchParams: SP }) {
  await connection();
  const { tab: raw } = await searchParams;
  const tab: Tab = raw === "topics" || raw === "sponsors" ? raw : "guests";
  const [s, decisions, lastRun] = await Promise.all([
    computeScores(),
    db().execute("select entity_type, a_name, b_name, method, verdict, reason, created_at from entity_decisions order by created_at desc limit 80"),
    db().execute("select finished_at, merged, pending from resolve_runs order by started_at desc limit 1"),
  ]);
  const run = lastRun.rows[0];
  // Not awaited: names render right away and the one-liners stream in when Gemini (or the cache) answers.
  const blurbs = tab === "guests"
    ? getBlurbs("guest", [...s.mediaRounds, ...s.earlyGuests.slice(0, EARLY_SHOWN)].map((g) => g.id))
    : tab === "topics" ? getBlurbs("topic", s.topics.map((t) => t.slug))
    : getBlurbs("brand", s.sponsors.slice(0, 15).map((b) => b.id));

  return (
    <>
      <p className="mt-3 text-sm text-ink-3">
        Week of {fmtDate(s.weekStart, { day: "numeric", month: "long" })} · computed {fmtDateTime(s.asOf)}
        {" · "}{run ? <>names last de-duplicated {ago(String(run.finished_at))}</> : <>names not de-duplicated yet, run <TextLink href="/admin/runs">Score and rank</TextLink></>}
      </p>

      <Tabs active={tab} counts={{ guests: s.mediaRounds.length + s.earlyGuests.length, topics: s.topics.length, sponsors: s.sponsors.length }} />

      {tab === "guests" && (
        <>
          <Section title="Who to book: media rounds" description="Guests on two or more of your shows in the last 30 days, most shows first.">
            {s.mediaRounds.length ? (
              <GuestList guests={s.mediaRounds} blurbs={blurbs} metric={(g) => <><b className="font-semibold text-ink">{g.shows}</b> shows · {g.appearances} {g.appearances === 1 ? "episode" : "episodes"}</>} />
            ) : (
              <EmptyState icon={UserRoundSearch} title="No guest is on two shows yet">
                No one has appeared on more than one monitored show in the last 30 days. This fills in as more episodes are extracted.
              </EmptyState>
            )}
          </Section>

          <Section title="Who to book: early guests"
            description={`Seen exactly once in all our data, in the last 30 days. Newest first${s.earlyGuests.length > EARLY_SHOWN ? `, showing ${EARLY_SHOWN} of ${s.earlyGuests.length}` : ""}.`}>
            {s.earlyGuests.length ? (
              <GuestList guests={s.earlyGuests.slice(0, EARLY_SHOWN)} blurbs={blurbs} metric={(g) => fmtDate(g.lastSeen)} />
            ) : (
              <EmptyState icon={Sparkles} title="No early guests">No first-time guests in the last 30 days.</EmptyState>
            )}
          </Section>
          <Merges rows={decisions.rows.filter((d) => d.entity_type === "guest")} kind="guest" />
        </>
      )}

      {tab === "topics" && (
        <>
          <Section title="What to cover: topic momentum"
            description="Episodes tagged this week against the average week over the 4 weeks before. Topics with fewer than 2 episodes in that time are hidden.">
            {s.topics.length ? (
              <Panel className="overflow-x-auto">
                <table className="num w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-ink-3">
                      <th className="px-5 py-2 font-medium">Topic</th>
                      <th className="py-2 text-right font-medium">Last 7 days</th>
                      <th className="py-2 text-right font-medium">Avg week before</th>
                      <th className="py-2 text-right font-medium">Ratio</th>
                      <th className="px-5 py-2 text-right font-medium">Trend</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {s.topics.map((t) => (
                      <tr key={t.slug} className="text-ink-2">
                        <td className="px-5 py-2.5 text-ink">{t.label}<Blurb blurbs={blurbs} id={t.slug} /></td>
                        <td className="py-2.5 text-right font-medium text-ink">{t.thisWeek}</td>
                        <td className="py-2.5 text-right">{t.priorAvg}</td>
                        <td className="py-2.5 text-right">{t.ratio === null ? "–" : `${t.ratio}×`}</td>
                        <td className="px-5 py-2.5 text-right">
                          {t.trend === "rising" ? <Pill tone="good"><TrendingUp className="size-3" /> Rising</Pill>
                            : t.trend === "falling" ? <Pill tone="bad"><TrendingDown className="size-3" /> Falling</Pill>
                            : t.trend === "new" ? <Pill tone="accent">New</Pill>
                            : <Pill>Steady</Pill>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            ) : (
              <EmptyState icon={TrendingUp} title="Not enough tagged episodes">Topic momentum needs at least 2 episodes per topic in the last 5 weeks.</EmptyState>
            )}
          </Section>
        </>
      )}

      {tab === "sponsors" && (
        <>
          <Section title="Who to pitch: active sponsors"
            description={<>Paid ad reads and sponsor disclosures in the last {s.weights.sponsorWindowDays} days. Score = shows × {s.weights.shows} + placements × {s.weights.placements} + up to {s.weights.recency} for recency (halves every {s.weights.halflifeDays} days).</>}>
            {s.sponsors.length ? (
              <Panel>
                <ul className="divide-y divide-line">
                  {s.sponsors.slice(0, 15).map((b, i) => (
                    <li key={b.id} className="px-5 py-3.5">
                      <details className="group">
                        <summary className="flex cursor-pointer list-none items-baseline gap-3">
                          <span className="num w-5 shrink-0 text-sm text-ink-3">{i + 1}</span>
                          <span className="min-w-0 flex-1">
                            <span className="font-medium text-ink">{b.name}</span>
                            <Blurb blurbs={blurbs} id={b.id} />
                          </span>
                          <span className="num text-sm text-ink-2">{b.shows} {b.shows === 1 ? "show" : "shows"} · {b.placements} {b.placements === 1 ? "placement" : "placements"} · last {fmtDate(b.lastSeen)}</span>
                          <span className="num w-12 text-right text-sm font-semibold text-ink">{b.score}</span>
                        </summary>
                        <Episodes episodes={b.episodes} />
                      </details>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : (
              <EmptyState icon={Megaphone} title="No paid placements found">No ad reads or sponsor disclosures in the window.</EmptyState>
            )}
          </Section>
          <Merges rows={decisions.rows.filter((d) => d.entity_type === "brand")} kind="brand" />
        </>
      )}
    </>
  );
}

function Merges({ rows, kind }: { rows: Row[]; kind: "guest" | "brand" }) {
  return (
    <Section title={kind === "guest" ? "Guest name merges" : "Brand name merges"} description="Near-identical names merge on their own. Borderline pairs are checked by Gemini, and both its yes and no answers are kept so a pair is never asked twice.">
      {rows.length ? (
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <tbody className="divide-y divide-line">
              {rows.map((d, i) => (
                <tr key={i} className="align-top text-ink-2">
                  <td className="px-5 py-2.5">{d.verdict === "merged" ? <Pill tone="good">Merged</Pill> : <Pill>Kept apart</Pill>}</td>
                  <td className="py-2.5 text-ink">{String(d.a_name)} <span className="text-ink-3">/</span> {String(d.b_name)}
                    <span className="block text-xs text-ink-3">{d.entity_type === "guest" ? "Guest" : "Brand"} · {d.method === "gemini" ? "checked by Gemini" : "near-identical spelling"}</span>
                  </td>
                  <td className="max-w-md px-5 py-2.5 text-xs text-ink-3">{String(d.reason ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : (
        <EmptyState icon={GitMerge} title="No merges yet">Run Score and rank on the Runs page to de-duplicate names.</EmptyState>
      )}
    </Section>
  );
}

const TABS: { key: Tab; label: string; hint: string; icon: typeof UserRoundSearch }[] = [
  { key: "guests", label: "Guests", hint: "Who to book", icon: UserRoundSearch },
  { key: "topics", label: "Topics", hint: "What to cover", icon: TrendingUp },
  { key: "sponsors", label: "Sponsors", hint: "Who to pitch", icon: Megaphone },
];

function Tabs({ active, counts }: { active: Tab; counts: Record<Tab, number> }) {
  return (
    <nav aria-label="Rankings" className="mt-6 border-b border-line">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {TABS.map(({ key, label, hint, icon: Icon }) => {
          const on = key === active;
          return (
            <li key={key}>
              <Link href={key === "guests" ? "/rankings" : `/rankings?tab=${key}`} scroll={false} aria-current={on ? "page" : undefined}
                className={`flex items-center gap-2.5 whitespace-nowrap border-b-2 px-3 pb-3 pt-1 transition-colors ${
                  on ? "border-accent text-ink" : "border-transparent text-ink-3 hover:border-line-strong hover:text-ink"}`}>
                <Icon className={`size-4 ${on ? "text-accent" : ""}`} strokeWidth={1.9} />
                <span className="leading-tight">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {label}
                    <span className={`num rounded-full px-1.5 text-xs ${on ? "bg-accent-soft text-accent-soft-ink" : "bg-surface-2 text-ink-3"}`}>{counts[key]}</span>
                  </span>
                  <span className="hidden text-xs text-ink-3 sm:block">{hint}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

type Blurbs = Promise<Map<string, string>>;

/** The one-line "who / what is this" under a name. Streams in; renders nothing if there's no line for it. */
function Blurb({ blurbs, id }: { blurbs: Blurbs; id: string }) {
  return (
    <Suspense fallback={<span aria-hidden className="mt-1.5 block h-3 w-2/3 max-w-sm animate-pulse rounded bg-surface-2" />}>
      <BlurbText blurbs={blurbs} id={id} />
    </Suspense>
  );
}

async function BlurbText({ blurbs, id }: { blurbs: Blurbs; id: string }) {
  const text = (await blurbs).get(id);
  return text ? <span className="mt-0.5 block text-sm font-normal text-ink-3">{text}</span> : null;
}

function GuestList({ guests, metric, blurbs }: { guests: GuestRank[]; metric: (g: GuestRank) => React.ReactNode; blurbs: Blurbs }) {
  return (
    <Panel>
      <ul className="divide-y divide-line">
        {guests.map((g) => (
          <li key={g.id} className="px-5 py-3.5">
            <details className="group">
              <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-ink">{g.name}</span>
                  {(g.company || g.role) && <span className="ml-2 text-sm text-ink-3">{[g.role, g.company].filter(Boolean).join(", ")}</span>}
                  <Blurb blurbs={blurbs} id={g.id} />
                </span>
                <span className="num text-sm text-ink-2">{metric(g)}</span>
                <Link href={`/guests/${g.id}`} className="inline-flex items-center gap-0.5 text-sm font-medium text-accent hover:underline">
                  Profile <ChevronRight className="size-3.5" />
                </Link>
              </summary>
              <Episodes episodes={g.episodes} />
            </details>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

const MENTION: Record<string, string> = { paid_read: "Ad read", sponsor_disclosure: "Sponsor" };

function Episodes({ episodes }: { episodes: EpisodeRef[] }) {
  return (
    <ul className="mt-2.5 space-y-1.5 border-l border-line pl-4 text-sm">
      {episodes.map((e) => (
        <li key={e.id} className="flex flex-wrap items-baseline gap-x-2">
          <ShowName name={e.show} className="text-xs text-ink-3" />
          <Link href={`/episodes/${e.id}`} className="min-w-0 flex-1 text-ink-2 hover:text-ink hover:underline">{e.title}</Link>
          {e.mentionType && <Pill>{MENTION[e.mentionType] ?? e.mentionType}</Pill>}
          <span className="num text-xs text-ink-3">{fmtDate(e.publishedAt)}</span>
        </li>
      ))}
      {!episodes.length && <li className="text-ink-3">No episodes</li>}
    </ul>
  );
}
