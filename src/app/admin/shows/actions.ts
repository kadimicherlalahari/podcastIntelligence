"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { db } from "@/lib/db";
import { ingestShow, loadCfg } from "@/lib/ingest";
import { refreshVideoStats } from "@/lib/stats";
import { getChannelsByIds, resolveChannelInput } from "@/lib/youtube";
import { getFeedById } from "@/lib/podcastindex";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const done = (showId?: string) => {
  revalidatePath("/admin/shows");
  if (showId) redirect(`/admin/shows?resolve=${showId}`);
};

export async function addShow(f: FormData) {
  const name = str(f, "name");
  if (name) await db().execute({ sql: "insert or ignore into shows (name) values (?)", args: [name] });
  done();
}

export async function updateShow(f: FormData) {
  const hosts = str(f, "host_names").split(",").map((h) => h.trim()).filter(Boolean);
  await db().execute({
    sql: "update shows set name = ?, host_names = ?, language = ? where id = ?",
    args: [str(f, "name"), JSON.stringify(hosts), str(f, "language") || null, str(f, "id")],
  });
  done();
}

export async function toggleActive(f: FormData) {
  await db().execute({
    sql: "update shows set active = ? where id = ?",
    args: [str(f, "active") === "1" ? 0 : 1, str(f, "id")],
  });
  done();
}

export async function confirmYoutube(f: FormData) {
  const id = str(f, "id");
  const channel = (await getChannelsByIds([str(f, "channelId")]))[0];
  if (!channel?.uploadsPlaylistId) throw new Error("Channel has no uploads playlist");
  await db().execute({
    sql: "update shows set youtube_channel_id = ?, youtube_uploads_playlist_id = ? where id = ?",
    args: [channel.channelId, channel.uploadsPlaylistId, id],
  });
  done(id);
}

// Paste a channel URL / @handle, resolve it, and store it directly (explicit user input, not a guess).
export async function confirmYoutubeByInput(f: FormData) {
  const id = str(f, "id");
  const channel = await resolveChannelInput(str(f, "input"));
  if (!channel?.uploadsPlaylistId) throw new Error("Could not resolve that channel");
  await db().execute({
    sql: "update shows set youtube_channel_id = ?, youtube_uploads_playlist_id = ? where id = ?",
    args: [channel.channelId, channel.uploadsPlaylistId, id],
  });
  done(id);
}

export async function confirmRss(f: FormData) {
  const id = str(f, "id");
  const feed = await getFeedById(Number(str(f, "feedId")));
  if (!feed) throw new Error("Feed not found in Podcast Index");
  await db().execute({
    sql: "update shows set rss_url = ?, podcastindex_feed_id = ?, language = coalesce(?, language) where id = ?",
    args: [feed.url, feed.id, feed.language || null, id],
  });
  done(id);
}

export async function confirmSpotify(f: FormData) {
  const id = str(f, "id");
  await db().execute({ sql: "update shows set spotify_show_id = ? where id = ?", args: [str(f, "spotifyId"), id] });
  done(id);
}

export type ChannelState = { ok?: boolean; message?: string };

// Overview: paste a YouTube channel URL or @handle to put it on the radar. Recent uploads are collected right after.
export async function addChannel(_prev: ChannelState, f: FormData): Promise<ChannelState> {
  const raw = str(f, "input");
  if (!raw) return { message: "Paste a YouTube channel link or @handle." };
  let channel;
  try { channel = await resolveChannelInput(raw); } catch (e) { return { message: (e as Error).message }; }
  if (!channel?.uploadsPlaylistId) {
    return { message: "Couldn't find that channel. Use a link like youtube.com/@handle or youtube.com/channel/UC…" };
  }
  const c = db();
  const dup = await c.execute({ sql: "select name from shows where youtube_channel_id = ?", args: [channel.channelId] });
  if (dup.rows.length) return { message: `${dup.rows[0].name} is already on your radar.` };
  // A show with the same name but no channel yet (e.g. a paused seed row) gets the channel and is switched on.
  const res = await c.execute({
    sql: `insert into shows (name, youtube_channel_id, youtube_uploads_playlist_id, active) values (?, ?, ?, 1)
          on conflict(name) do update set youtube_channel_id = excluded.youtube_channel_id,
            youtube_uploads_playlist_id = excluded.youtube_uploads_playlist_id, active = 1
          returning id, name, host_names`,
    args: [channel.title, channel.channelId, channel.uploadsPlaylistId],
  });
  const row = res.rows[0];
  after(async () => {
    try {
      await ingestShow({
        id: String(row.id), name: String(row.name), youtube_uploads_playlist_id: channel.uploadsPlaylistId!,
        rss_url: null, host_names: JSON.parse(String(row.host_names ?? "[]")),
      }, await loadCfg());
      await refreshVideoStats();
    } catch (e) {
      console.error(`first collection for ${row.name} failed:`, (e as Error).message);
    }
  });
  revalidatePath("/");
  revalidatePath("/admin/shows");
  return { ok: true, message: `${channel.title} added. Collecting its recent uploads now; refresh in a minute.` };
}

// Removes a show and everything collected from it. The confirm step lives in the client button.
export async function removeShow(f: FormData) {
  const id = str(f, "id");
  const eps = "select id from episodes where show_id = ?";
  await db().batch([
    { sql: `delete from episode_topics where episode_id in (${eps})`, args: [id] },
    { sql: `delete from appearances where episode_id in (${eps})`, args: [id] },
    { sql: `delete from brand_mentions where episode_id in (${eps})`, args: [id] },
    { sql: "delete from episodes where show_id = ?", args: [id] },
    { sql: "delete from shows where id = ?", args: [id] },
  ], "write");
  revalidatePath("/");
  revalidatePath("/admin/shows");
}
