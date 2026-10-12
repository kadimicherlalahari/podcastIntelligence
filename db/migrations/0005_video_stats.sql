-- YouTube reach per episode, refreshed after each ingest and lazily by the Overview page.
alter table episodes add column view_count integer;
alter table episodes add column like_count integer;
alter table episodes add column comment_count integer;
alter table episodes add column stats_at text;
