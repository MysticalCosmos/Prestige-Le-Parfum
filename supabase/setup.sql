-- 1) PROFILES: one row per user, holds the role ('customer' or 'admin')
create table if not exists public.profiles (
  id        uuid primary key references auth.users(id) on delete cascade,
  email     text,
  full_name text,
  role      text not null default 'customer' check (role in ('customer','admin'))
);
alter table public.profiles enable row level security;

-- helper used by the rules below
create or replace function public.is_admin()
returns boolean language sql security definer set search_path = public stable
as $$ select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') $$;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles for select using (id = auth.uid());
drop policy if exists "admin reads all profiles" on public.profiles;
create policy "admin reads all profiles" on public.profiles for select using (public.is_admin());
-- (no insert/update policies on purpose: nobody can change their own role from the browser)

-- every new signup automatically gets a profile, always as 'customer'
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- profiles for any users that already exist
insert into public.profiles (id, email)
select id, email from auth.users on conflict (id) do nothing;

-- 2) PRODUCTS: the prices live here, so the browser can't fake them
create table if not exists public.products (
  id    serial primary key,
  name  text not null unique,
  price numeric(10,2) not null check (price >= 0)
);
alter table public.products enable row level security;
drop policy if exists "anyone reads products" on public.products;
create policy "anyone reads products" on public.products for select using (true);

insert into public.products (name, price) values
  ('Noir Royal', 168), ('Velours d''Or', 154), ('Ambre Imperial', 192), ('Soie Blanche', 146)
on conflict (name) do nothing;

-- 3) ORDERS + ORDER_ITEMS
create sequence if not exists public.order_no_seq start 1001;

create table if not exists public.orders (
  id         uuid primary key default gen_random_uuid(),
  order_no   text not null unique default ('PLP-' || nextval('public.order_no_seq')::text),
  user_id    uuid not null references public.profiles(id),
  status     text not null default 'pending' check (status in ('pending','paid','shipped','delivered','cancelled')),
  total      numeric(10,2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id           bigserial primary key,
  order_id     uuid not null references public.orders(id) on delete cascade,
  product_name text not null,
  unit_price   numeric(10,2) not null,
  qty          int not null check (qty > 0)
);

alter table public.orders enable row level security;
alter table public.order_items enable row level security;

drop policy if exists "customer reads own orders" on public.orders;
create policy "customer reads own orders" on public.orders for select using (user_id = auth.uid());
drop policy if exists "admin reads all orders" on public.orders;
create policy "admin reads all orders" on public.orders for select using (public.is_admin());

drop policy if exists "customer reads own items" on public.order_items;
create policy "customer reads own items" on public.order_items for select
  using (exists (select 1 from public.orders o where o.id = order_id and o.user_id = auth.uid()));
drop policy if exists "admin reads all items" on public.order_items;
create policy "admin reads all items" on public.order_items for select using (public.is_admin());
-- (no insert policies: orders can ONLY be created through place_order() below)

-- 4) THE TRANSACTION: place_order. All-or-nothing; prices come from the products table.
create or replace function public.place_order(p_items jsonb)
returns json language plpgsql security definer set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_order public.orders;
  v_prod  public.products;
  v_item  jsonb;
  v_qty   int;
  v_total numeric(10,2) := 0;
begin
  if v_uid is null then raise exception 'Please sign in to place an order.'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Your bag is empty.';
  end if;

  insert into public.orders (user_id) values (v_uid) returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'qty')::int;
    if v_qty is null or v_qty < 1 or v_qty > 20 then raise exception 'Invalid quantity.'; end if;
    select * into v_prod from public.products where name = v_item->>'name';
    if v_prod.id is null then raise exception 'Unknown product: %', v_item->>'name'; end if;

    insert into public.order_items (order_id, product_name, unit_price, qty)
    values (v_order.id, v_prod.name, v_prod.price, v_qty);
    v_total := v_total + v_prod.price * v_qty;
  end loop;

  update public.orders set total = v_total where id = v_order.id returning * into v_order;

  return json_build_object('order_id', v_order.id, 'order_no', v_order.order_no,
                           'total', v_order.total, 'status', v_order.status);
end;
$$;
revoke all on function public.place_order(jsonb) from public;
grant execute on function public.place_order(jsonb) to authenticated;

-- 5) NEWSLETTER (the form you already have)
create table if not exists public.newsletter_subscribers (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  created_at  timestamptz not null default now(),
  constraint newsletter_email_lowercase check (email = lower(email)),
  constraint newsletter_email_format
    check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 254)
);
alter table public.newsletter_subscribers enable row level security;

create or replace function public.subscribe_newsletter(p_email text)
returns json language plpgsql security definer set search_path = public
as $$
declare
  v_email text := lower(trim(p_email));
  v_row   public.newsletter_subscribers;
  v_dupe  boolean := false;
begin
  insert into public.newsletter_subscribers (email) values (v_email)
  on conflict (email) do nothing returning * into v_row;
  if v_row.id is null then
    v_dupe := true;
    select * into v_row from public.newsletter_subscribers where email = v_email;
  end if;
  return json_build_object('id', v_row.id, 'email', v_row.email,
                           'created_at', v_row.created_at, 'already_subscribed', v_dupe);
end;
$$;
revoke all on function public.subscribe_newsletter(text) from public;
grant execute on function public.subscribe_newsletter(text) to anon;
