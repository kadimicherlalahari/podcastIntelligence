-- One-line "who / what is this" notes shown on the Rankings tabs. Written by Gemini from our own episode data, cached.
create table if not exists blurbs (
  entity_type text not null check (entity_type in ('guest','topic','brand')),
  entity_id text not null,
  text text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  primary key (entity_type, entity_id)
);
