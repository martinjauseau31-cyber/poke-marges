-- PokéMarges — schéma Supabase
-- À coller dans Supabase → SQL Editor → Run.
-- Tout est protégé par Row Level Security : chaque compte ne voit que ses
-- propres lignes, même si la clé publique du site est visible par tout le monde.

-- ---------------------------------------------------------------- articles
create table if not exists public.items (
  id            text        not null,
  user_id       uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  kind          text        not null default 'carte'  check (kind in ('carte','gradee','scelle')),
  card_id       text,
  name          text        not null,
  set_id        text,
  set_name      text,
  local_id      text,
  grader        text,
  grade         text,
  status        text        not null default 'stock'  check (status in ('stock','gradation','livraison')),
  qty           integer     not null default 1        check (qty >= 0),
  buy_price     numeric(10,2),
  manual_value  numeric(10,2),
  condition     text,
  added_at      timestamptz not null default now(),
  primary key (user_id, id)
);

-- ------------------------------------------------------------------ ventes
create table if not exists public.sales (
  id          text        not null,
  user_id     uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  item_id     text,
  name        text        not null,
  kind        text,
  sold_on     date        not null default current_date,
  qty         integer     not null default 1 check (qty > 0),
  gross       numeric(10,2) not null default 0,
  fees        numeric(10,2) not null default 0,
  platform    text,
  buy_price   numeric(10,2) not null default 0,
  created_at  timestamptz not null default now(),
  primary key (user_id, id)
);

-- ------------------------------------- valeurs du scellé (écrites par le Mac)
-- Les cotes des cartes ne sont PAS stockées ici : le site les lit en direct
-- chez TCGdex à chaque ouverture, donc elles sont toujours à jour.
create table if not exists public.prices (
  item_id     text        not null,
  user_id     uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  name        text,
  median      numeric(10,2),
  p25         numeric(10,2),
  p75         numeric(10,2),
  low         numeric(10,2),
  high        numeric(10,2),
  sample      integer,
  dispersion  numeric(6,2),
  source      text,
  updated_at  timestamptz not null default now(),
  primary key (user_id, item_id)
);

-- --------------------------------------------- relevés quotidiens (courbe)
create table if not exists public.history (
  day        date        not null default current_date,
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  parc       numeric(12,2) not null default 0,
  invested   numeric(12,2) not null default 0,
  cash       numeric(12,2) not null default 0,
  margin     numeric(12,2) not null default 0,
  units      integer     not null default 0,
  primary key (user_id, day)
);

-- ------------------------------------------------------ Row Level Security
alter table public.items   enable row level security;
alter table public.sales   enable row level security;
alter table public.prices  enable row level security;
alter table public.history enable row level security;

do $$
declare t text;
begin
  foreach t in array array['items','sales','prices','history'] loop
    execute format('drop policy if exists "proprietaire" on public.%I', t);
    execute format(
      'create policy "proprietaire" on public.%I
         for all
         using (auth.uid() = user_id)
         with check (auth.uid() = user_id)', t);
  end loop;
end $$;
