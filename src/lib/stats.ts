import { db } from "./db-core";
import { getVideoStats } from "./youtube";

const DAY = 86_400_000;
const STALE_MS = 6 * 3_600_000;

/** Refreshes YouTube views/likes/comments for full episodes published in the last `days`. ~1 quota unit per 50 videos. */
export async function refreshVideoStats(days = 45): Promise<number> {
  const c = db();
  const { rows } = await c.execute({
    sql: "select id, youtube_video_id v from episodes where kind = 'full' and youtube_video_id is not null and published_at >= ?",
    args: [new Date(Date.now() - days * DAY).toISOString()],
  });
  if (!rows.length) return 0;
  const byVideo = new Map(rows.map((r) => [String(r.v), String(r.id)]));
  const stats = await getVideoStats([...byVideo.keys()]);
  const at = new Date().toISOString();
  await c.batch(stats.map((s) => ({
    sql: "update episodes set view_count = ?, like_count = ?, comment_count = ?, stats_at = ? where id = ?",
    args: [s.views, s.likes, s.comments, at, byVideo.get(s.id)!],
  })), "write");
  return stats.length;
}

/** Refreshes only when the newest stats are older than 6 hours. Never throws: stale numbers beat a broken page. */
export async function refreshVideoStatsIfStale(): Promise<void> {
  try {
    const { rows } = await db().execute("select max(stats_at) at from episodes");
    const at = rows[0]?.at ? Date.parse(String(rows[0].at)) : 0;
    if (Date.now() - at > STALE_MS) await refreshVideoStats();
  } catch (e) {
    console.error("video stats refresh failed:", (e as Error).message);
  }
}
