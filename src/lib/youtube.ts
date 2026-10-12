const BASE = "https://www.googleapis.com/youtube/v3";

export type YtCandidate = {
  channelId: string;
  title: string;
  handle?: string;
  subscriberCount?: number;
  uploadsPlaylistId?: string;
};

async function yt(path: string, params: Record<string, string>) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YOUTUBE_API_KEY not set");
  const res = await fetch(`${BASE}/${path}?${new URLSearchParams({ ...params, key })}`);
  if (!res.ok) throw new Error(`YouTube ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

type ChannelItem = {
  id: string;
  snippet?: { title?: string; customUrl?: string };
  statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
};

function toCandidate(c: ChannelItem): YtCandidate {
  const subs = c.statistics?.hiddenSubscriberCount ? undefined : c.statistics?.subscriberCount;
  return {
    channelId: c.id,
    title: c.snippet?.title ?? "",
    handle: c.snippet?.customUrl,
    subscriberCount: subs ? Number(subs) : undefined,
    uploadsPlaylistId: c.contentDetails?.relatedPlaylists?.uploads,
  };
}

const PARTS = "snippet,statistics,contentDetails";

export async function getChannelsByIds(ids: string[]): Promise<YtCandidate[]> {
  if (!ids.length) return [];
  const data = await yt("channels", { part: PARTS, id: ids.join(",") });
  return (data.items ?? []).map(toCandidate);
}

// search.list costs 100 quota units: one-off resolution only, never routine ingestion.
export async function searchChannels(name: string, max = 5): Promise<YtCandidate[]> {
  const data = await yt("search", { part: "snippet", type: "channel", q: name, maxResults: String(max) });
  const ids: string[] = (data.items ?? []).map((i: { id: { channelId: string } }) => i.id.channelId);
  return getChannelsByIds(ids);
}

// Accepts @handle, a youtube.com/@handle URL, or a youtube.com/channel/UC... URL.
export async function resolveChannelInput(input: string): Promise<YtCandidate | null> {
  const s = input.trim();
  const idMatch = s.match(/channel\/(UC[\w-]{20,})/) ?? s.match(/^(UC[\w-]{20,})$/);
  if (idMatch) return (await getChannelsByIds([idMatch[1]]))[0] ?? null;
  const handle = s.match(/@([\w.\-]+)/)?.[1];
  if (!handle) return null;
  const data = await yt("channels", { part: PARTS, forHandle: `@${handle}` });
  return data.items?.[0] ? toCandidate(data.items[0]) : null;
}

export type PlaylistEntry = { videoId: string; publishedAt: string };

// playlistItems.list: 1 quota unit per page of up to 50.
export async function listUploads(playlistId: string, pageToken?: string) {
  const params: Record<string, string> = { part: "contentDetails", playlistId, maxResults: "50" };
  if (pageToken) params.pageToken = pageToken;
  const data = await yt("playlistItems", params);
  const items: PlaylistEntry[] = (data.items ?? []).map(
    (i: { contentDetails: { videoId: string; videoPublishedAt?: string } }) => ({
      videoId: i.contentDetails.videoId,
      publishedAt: i.contentDetails.videoPublishedAt ?? "",
    }),
  );
  return { items, nextPageToken: data.nextPageToken as string | undefined };
}

export type YtVideo = {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  duration: string;
  liveBroadcastContent: string;
};

// videos.list: 1 quota unit per call of up to 50 ids.
export async function getVideos(ids: string[]): Promise<YtVideo[]> {
  const out: YtVideo[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const data = await yt("videos", { part: "snippet,contentDetails,liveStreamingDetails", id: ids.slice(i, i + 50).join(",") });
    for (const v of data.items ?? []) {
      out.push({
        id: v.id,
        title: v.snippet?.title ?? "",
        description: v.snippet?.description ?? "",
        publishedAt: v.snippet?.publishedAt ?? "",
        duration: v.contentDetails?.duration ?? "",
        liveBroadcastContent: v.snippet?.liveBroadcastContent ?? "none",
      });
    }
  }
  return out;
}

export type YtStats = { id: string; views: number | null; likes: number | null; comments: number | null };

// videos.list part=statistics: 1 quota unit per call of up to 50 ids.
export async function getVideoStats(ids: string[]): Promise<YtStats[]> {
  const num = (v?: string) => (v === undefined ? null : Number(v));
  const out: YtStats[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const data = await yt("videos", { part: "statistics", id: ids.slice(i, i + 50).join(",") });
    for (const v of data.items ?? []) {
      const s = v.statistics ?? {};
      out.push({ id: v.id, views: num(s.viewCount), likes: num(s.likeCount), comments: num(s.commentCount) });
    }
  }
  return out;
}
