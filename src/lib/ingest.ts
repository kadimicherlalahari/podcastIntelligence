import Parser from "rss-parser";
import { db } from "./db-core";
import { classifyKind, type Kind } from "./classify";
import { isSameEpisode } from "./match";
import { decodeEntities } from "./evidence";
import { parseClockDuration, parseIsoDuration } from "./duration";
import { getVideos, listUploads } from "./youtube";
import { refreshVideoStats } from "./stats";

export type Cfg = { clipMaxMinutes: number; titleThreshold: number; windowDays: number };
export type ShowRow = {
  id: string; name: string; youtube_uploads_playlist_id: string | null; rss_url: string | null; host_names: string[];
};
export type ShowStats = {
  yt_new: number; rss_new: number; merged: number; inserted: number; yt_calls: number;
  by_kind: Record<Kind, number>; errors: string[];
};

type Item = {
  source: "youtube" | "rss";
  ytId?: string; guid?: string; title: string; description: string; publishedAt: string;
  durationSeconds: number | null; kind: Kind; url?: string; audioUrl?: string;
};
type Row = {
  id: string; title: string; description: string; publishedAt: string; kind: Kind; ytId: string | null;
  guid: string | null; sources: Record<string, string>; audioUrl: string | null; durationSeconds: number | null;
};

const DAY = 86_400_000;
const RSS_DAYS = 60;
const YT_DAYS = 60; // kept equal to the RSS window so both sources cover the same period
const MAX_PAGES = 30;

export async function loadCfg(): Promise<Cfg> {
  const { rows } = await db().execute("select key, value from scoring_config");
  const m = Object.fromEntries(rows.map((r) => [String(r.key), Number(r.value)]));
  return {
    clipMaxMinutes: m.clip_max_minutes ?? 15,
    titleThreshold: m.title_match_threshold ?? 0.85,
    windowDays: m.match_window_days ?? 3,
  };
}

export async function loadActiveShows(): Promise<ShowRow[]> {
  const { rows } = await db().execute("select * from shows where active = 1 order by name");
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    youtube_uploads_playlist_id: (r.youtube_uploads_playlist_id as string) || null,
    rss_url: (r.rss_url as string) || null,
    host_names: JSON.parse(String(r.host_names ?? "[]")),
  }));
}

const stripHtml = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\u00A0/g, " ").replace(/\s+\n/g, "\n").trim();

function mergeText(a: string, b: string): string {
  if (!b || a === b || a.includes(b)) return a;
  if (!a || b.includes(a)) return b;
  return `${a}\n\n${b}`;
}

async function fetchYoutube(playlistId: string, maxPages: number, stats: ShowStats, known: Set<string>, cfg: Cfg) {
  const cutoff = Date.now() - YT_DAYS * DAY;
  const fresh: string[] = [];
  let token: string | undefined;
  for (let page = 0; page < Math.min(maxPages, MAX_PAGES); page++) {
    const res = await listUploads(playlistId, token);
    stats.yt_calls++;
    let reachedOld = false;
    for (const it of res.items) {
      if (it.publishedAt && Date.parse(it.publishedAt) < cutoff) reachedOld = true;
      else if (!known.has(it.videoId)) fresh.push(it.videoId);
    }
    token = res.nextPageToken;
    if (!token || reachedOld) break;
  }
  if (!fresh.length) return [];
  const videos = await getVideos(fresh);
  stats.yt_calls += Math.ceil(fresh.length / 50);
  return videos.map((v): Item => {
    const durationSeconds = parseIsoDuration(v.duration);
    return {
      source: "youtube", ytId: v.id, title: decodeEntities(v.title), description: decodeEntities(v.description), publishedAt: v.publishedAt,
      durationSeconds, url: `https://www.youtube.com/watch?v=${v.id}`,
      kind: classifyKind(
        { title: v.title, description: v.description, durationSeconds, liveBroadcastContent: v.liveBroadcastContent },
        cfg.clipMaxMinutes,
      ),
    };
  });
}

async function fetchRss(rssUrl: string, known: Set<string>, cfg: Cfg) {
  const parser = new Parser({
    timeout: 30_000,
    customFields: { item: [["itunes:duration", "itunesDuration"], ["itunes:episode", "itunesEpisode"]] },
  });
  const feed = await parser.parseURL(rssUrl);
  const cutoff = Date.now() - RSS_DAYS * DAY;
  const items: Item[] = [];
  for (const it of feed.items) {
    const published = it.isoDate ?? (it.pubDate ? new Date(it.pubDate).toISOString() : "");
    const guid = it.guid ?? it.link;
    if (!published || !guid || !it.title || Date.parse(published) < cutoff || known.has(guid)) continue;
    const raw = it as unknown as { itunesDuration?: string; itunes?: { duration?: string }; content?: string };
    const durationSeconds = parseClockDuration(raw.itunesDuration ?? raw.itunes?.duration);
    const description = stripHtml(raw.content ?? it.contentSnippet ?? "");
    items.push({
      source: "rss", guid, title: it.title, description, publishedAt: published, durationSeconds,
      url: it.link, audioUrl: it.enclosure?.url,
      kind: classifyKind({ title: it.title, description, durationSeconds }, cfg.clipMaxMinutes),
    });
  }
  return items;
}

export async function ingestShow(show: ShowRow, cfg: Cfg, opts: { youtubeMaxPages?: number } = {}): Promise<ShowStats> {
  const stats: ShowStats = {
    yt_new: 0, rss_new: 0, merged: 0, inserted: 0, yt_calls: 0,
    by_kind: { full: 0, clip: 0, trailer: 0, live_upcoming: 0 }, errors: [],
  };
  const c = db();
  const { rows: dbRows } = await c.execute({
    sql: "select * from episodes where show_id = ? and published_at >= ?",
    args: [show.id, new Date(Date.now() - (YT_DAYS + 30) * DAY).toISOString()],
  });
  const rows: Row[] = dbRows.map((r) => ({
    id: String(r.id), title: String(r.title), description: String(r.description ?? ""),
    publishedAt: String(r.published_at ?? ""), kind: r.kind as Kind, ytId: (r.youtube_video_id as string) || null,
    guid: (r.rss_guid as string) || null, sources: JSON.parse(String(r.source_urls ?? "{}")),
    audioUrl: (r.audio_url as string) || null, durationSeconds: (r.duration_seconds as number) ?? null,
  }));
  const { rows: idRows } = await c.execute({
    sql: "select youtube_video_id y, rss_guid g from episodes where show_id = ?",
    args: [show.id],
  });
  const knownYt = new Set(idRows.map((r) => r.y as string).filter(Boolean));
  const knownGuid = new Set(idRows.map((r) => r.g as string).filter(Boolean));

  let yt: Item[] = [];
  let rss: Item[] = [];
  if (show.youtube_uploads_playlist_id) {
    try { yt = await fetchYoutube(show.youtube_uploads_playlist_id, opts.youtubeMaxPages ?? 1, stats, knownYt, cfg); }
    catch (e) { stats.errors.push(`youtube: ${(e as Error).message}`); }
  }
  if (show.rss_url) {
    try { rss = await fetchRss(show.rss_url, knownGuid, cfg); }
    catch (e) { stats.errors.push(`rss: ${(e as Error).message}`); }
  }
  stats.yt_new = yt.length;
  stats.rss_new = rss.length;

  const strip = { showName: show.name, hostNames: show.host_names };
  // YouTube first so RSS items merge into YouTube rows (or vice versa for pre-existing rows).
  for (const item of [...yt, ...rss]) {
    try {
      const idKey = item.source === "youtube" ? "ytId" : "guid";
      const other = rows.find(
        (r) =>
          r[idKey] === null &&
          isSameEpisode(
            { showId: show.id, title: item.title, publishedAt: item.publishedAt, kind: item.kind },
            { showId: show.id, title: r.title, publishedAt: r.publishedAt, kind: r.kind },
            cfg.titleThreshold, cfg.windowDays, strip,
          ),
      );
      const url = item.url ? { [item.source]: item.url } : {};
      if (other) {
        const sources = { ...other.sources, ...url, ...(item.audioUrl ? { audio: item.audioUrl } : {}) };
        const description = mergeText(other.description, item.description);
        const publishedAt = item.publishedAt < other.publishedAt ? item.publishedAt : other.publishedAt;
        const duration = other.durationSeconds ?? item.durationSeconds;
        await c.execute({
          sql: `update episodes set description = ?, published_at = ?, duration_seconds = ?, source_urls = ?,
                  audio_url = coalesce(audio_url, ?),
                  youtube_video_id = coalesce(youtube_video_id, ?), rss_guid = coalesce(rss_guid, ?) where id = ?`,
          args: [description, publishedAt, duration, JSON.stringify(sources), item.audioUrl ?? null,
            item.ytId ?? null, item.guid ?? null, other.id],
        });
        Object.assign(other, { description, publishedAt, durationSeconds: duration, sources, [idKey]: item[idKey] });
        stats.merged++;
        continue;
      }
      const res = await c.execute({
        sql: `insert or ignore into episodes (show_id, title, description, published_at, duration_seconds, kind,
                youtube_video_id, rss_guid, audio_url, source_urls, status)
              values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        args: [show.id, item.title, item.description, item.publishedAt, item.durationSeconds, item.kind,
          item.ytId ?? null, item.guid ?? null, item.audioUrl ?? null, JSON.stringify(url),
          item.kind === "full" ? "pending_extraction" : "skipped"],
      });
      if (!res.rows.length) continue; // already stored (unique index)
      stats.inserted++;
      stats.by_kind[item.kind]++;
      rows.push({
        id: String(res.rows[0].id), title: item.title, description: item.description, publishedAt: item.publishedAt,
        kind: item.kind, ytId: item.ytId ?? null, guid: item.guid ?? null, sources: url as Record<string, string>,
        audioUrl: item.audioUrl ?? null, durationSeconds: item.durationSeconds,
      });
    } catch (e) {
      stats.errors.push(`${item.source} "${item.title.slice(0, 40)}": ${(e as Error).message}`);
    }
  }
  return stats;
}

// Ingests all active shows sequentially; one show failing never stops the others. Logs an ingest_runs row.
export async function ingestAll(opts: { youtubeMaxPages?: number; log?: (s: string) => void } = {}) {
  const c = db();
  const cfg = await loadCfg();
  const shows = await loadActiveShows();
  const started = new Date().toISOString();
  const perShow: Record<string, ShowStats> = {};
  const errors: string[] = [];
  for (const show of shows) {
    try {
      perShow[show.name] = await ingestShow(show, cfg, opts);
      errors.push(...perShow[show.name].errors.map((e) => `${show.name}: ${e}`));
      opts.log?.(`${show.name}: ${JSON.stringify({ ...perShow[show.name], errors: undefined })}`);
    } catch (e) {
      errors.push(`${show.name}: ${(e as Error).message}`);
    }
  }
  try { await refreshVideoStats(); } catch (e) { errors.push(`video stats: ${(e as Error).message}`); }
  await c.execute({
    sql: "insert into ingest_runs (started_at, finished_at, per_show, errors) values (?, ?, ?, ?)",
    args: [started, new Date().toISOString(), JSON.stringify(perShow), JSON.stringify(errors)],
  });
  return { perShow, errors };
}
