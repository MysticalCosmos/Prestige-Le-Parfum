alter table public.products
  add column if not exists category    text,
  add column if not exists badge       text,
  add column if not exists notes       text,
  add column if not exists description text,
  add column if not exists image_path  text,
  add column if not exists featured    boolean not null default false,
  add column if not exists is_active   boolean not null default true,
  add column if not exists sort_order  int not null default 100,
  add column if not exists created_at  timestamptz not null default now();

drop policy if exists "anyone reads products" on public.products;
drop policy if exists "read active products" on public.products;
create policy "read active products" on public.products for select using (is_active or public.is_admin());
drop policy if exists "admin manages products" on public.products;
create policy "admin manages products" on public.products for all using (public.is_admin()) with check (public.is_admin());

create or replace function public.block_inactive_products()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.products where name = new.product_name and is_active) then
    raise exception 'Sorry, % is no longer available.', new.product_name;
  end if;
  return new;
end;
$$;
drop trigger if exists block_inactive_products on public.order_items;
create trigger block_inactive_products before insert on public.order_items
  for each row execute function public.block_inactive_products();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('products', 'products', true, 5242880, array['image/png','image/jpeg','image/webp','image/avif'])
on conflict (id) do update set public = true, file_size_limit = 5242880,
  allowed_mime_types = array['image/png','image/jpeg','image/webp','image/avif'];

drop policy if exists "public read product images" on storage.objects;
create policy "public read product images" on storage.objects for select using (bucket_id = 'products');
drop policy if exists "admin adds product images" on storage.objects;
create policy "admin adds product images" on storage.objects for insert with check (bucket_id = 'products' and public.is_admin());
drop policy if exists "admin edits product images" on storage.objects;
create policy "admin edits product images" on storage.objects for update using (bucket_id = 'products' and public.is_admin());
drop policy if exists "admin deletes product images" on storage.objects;
create policy "admin deletes product images" on storage.objects for delete using (bucket_id = 'products' and public.is_admin());

delete from public.products where name in ('Noir Royal', 'Velours d''Or', 'Ambre Imperial', 'Soie Blanche');

insert into public.products (name, category, price, badge, notes, description, image_path, featured, sort_order) values
  ('Tobacco Vanille', 'Oriental', 118, null, 'Amber, vanilla, warm spices', 'A rich, enveloping fragrance with amber and spice that lingers beautifully on skin.', 'tobacco-vanille.png', false, 100),
  ('Afternoon Swim', 'Fresh', 64, null, 'Citrus, sea breeze, white musk', 'A clean, airy eau de parfum with a bright opening and a soft, lasting dry-down.', 'afternoon-swim.png', false, 101),
  ('Alfa Romeo Green Cologne', 'Fresh', 58, null, 'Citrus, sea breeze, white musk', 'A clean, airy eau de parfum with a bright opening and a soft, lasting dry-down.', 'alfa-romeo-green-cologne.png', false, 102),
  ('Ambre Imperial', 'Oriental', 192, 'Limited', 'Amber, vanilla, warm spices', 'A rich, enveloping fragrance with amber and spice that lingers beautifully on skin.', 'ambre-imperial.png', false, 103),
  ('Ambre', 'Oriental', 96, null, 'Amber, vanilla, warm spices', 'A rich, enveloping fragrance with amber and spice that lingers beautifully on skin.', 'ambre.png', false, 104),
  ('Azure Lime', 'Fresh', 72, null, 'Citrus, sea breeze, white musk', 'A clean, airy eau de parfum with a bright opening and a soft, lasting dry-down.', 'azure-lime.png', false, 105),
  ('Baby Powder', 'Sweet', 48, null, 'Powdery musk, vanilla, soft florals', 'A playful, gourmand fragrance that is creamy, sweet and easy to wear every day.', 'baby-powder.png', false, 106),
  ('Baby', 'Sweet', 46, null, 'Soft musk, milk, vanilla', 'A playful, gourmand fragrance that is creamy, sweet and easy to wear every day.', 'baby.png', false, 107),
  ('Benetton', 'Fresh', 52, null, 'Citrus, sea breeze, white musk', 'A clean, airy eau de parfum with a bright opening and a soft, lasting dry-down.', 'benetton.png', false, 108),
  ('Cherry Cream', 'Sweet', 56, null, 'Black cherry, cream, vanilla', 'A playful, gourmand fragrance that is creamy, sweet and easy to wear every day.', 'cherry-cream.png', false, 109),
  ('Cherry Powder', 'Sweet', 56, null, 'Cherry, powdery musk, vanilla', 'A playful, gourmand fragrance that is creamy, sweet and easy to wear every day.', 'cherry-powder.png', false, 110),
  ('Cherry Temptation', 'Sweet', 62, 'New', 'Dark cherry, almond, vanilla', 'A playful, gourmand fragrance that is creamy, sweet and easy to wear every day.', 'cherry-temptation.png', true, 12),
  ('Coach Green EDT', 'Fresh', 78, null, 'Citrus, sea breeze, white musk', 'A clean, airy eau de parfum with a bright opening and a soft, lasting dry-down.', 'coach-green-edt.png', false, 112),
  ('Cuban Tobacco', 'Spicy', 88, null, 'Tobacco leaf, rum, warm spices', 'A bold, confident scent with a spicy heart and a smoky, sensual base.', 'cuban-tobacco.png', false, 113),
  ('Cuide Se Bem Show', 'Floral', 54, null, 'Jasmine, rose, soft musk', 'An elegant floral composition, soft and radiant from the first spray to the last.', 'cuide-se-bem-show.png', false, 114),
  ('Demeter Basil', 'Aromatic', 42, null, 'Fresh basil, green leaves, citrus', 'A refined aromatic fragrance, herbal and green, with a calm, polished finish.', 'demeter-basil.png', false, 116),
  ('Duro', 'Woody', 76, null, 'Cedar, vetiver, amber', 'A warm, grounded blend of woods and amber, made for evenings and cooler days.', 'duro.png', false, 117),
  ('Elysia Elegance', 'Floral', 84, null, 'Jasmine, rose, soft musk', 'An elegant floral composition, soft and radiant from the first spray to the last.', 'elysia-elegance.png', false, 118),
  ('Eros Flame', 'Spicy', 124, 'Limited', 'Pepper, tobacco, smoky amber', 'A bold, confident scent with a spicy heart and a smoky, sensual base.', 'eros-flame.png', true, 20),
  ('Fireplace', 'Woody', 44, null, 'Burnt wood, smoke, amber', 'A warm, grounded blend of woods and amber, made for evenings and cooler days.', 'fireplace.png', false, 120),
  ('Fleur de Thé', 'Floral', 92, null, 'White tea, jasmine, musk', 'An elegant floral composition, soft and radiant from the first spray to the last.', 'fleur-de-the.png', false, 121),
  ('Iconic', 'Oriental', 92, null, 'Amber, vanilla, warm spices', 'A rich, enveloping fragrance with amber and spice that lingers beautifully on skin.', 'iconic.png', false, 122),
  ('Intimissimi', 'Floral', 66, null, 'Jasmine, rose, soft musk', 'An elegant floral composition, soft and radiant from the first spray to the last.', 'intimissimi.png', false, 123),
  ('Invictus Aqua', 'Fresh', 112, 'Popular', 'Citrus, sea breeze, white musk', 'A clean, airy eau de parfum with a bright opening and a soft, lasting dry-down.', 'invictus-aqua.png', true, 25),
  ('Iris', 'Floral', 88, null, 'Jasmine, rose, soft musk', 'An elegant floral composition, soft and radiant from the first spray to the last.', 'iris.png', false, 125),
  ('Jo Tobacco & Mandarin', 'Spicy', 96, null, 'Tobacco, mandarin, amber', 'A bold, confident scent with a spicy heart and a smoky, sensual base.', 'jo-tobacco-mandarin.png', false, 126),
  ('Lattafa Dukhran', 'Oriental', 64, null, 'Amber, vanilla, warm spices', 'A rich, enveloping fragrance with amber and spice that lingers beautifully on skin.', 'lattafa-dukhran.png', false, 127),
  ('Le Male', 'Oriental', 128, 'Best seller', 'Amber, vanilla, warm spices', 'A rich, enveloping fragrance with amber and spice that lingers beautifully on skin.', 'le-male.png', true, 29),
  ('Mancera Red', 'Spicy', 138, 'New', 'Red fruit, tobacco, spice', 'A bold, confident scent with a spicy heart and a smoky, sensual base.', 'mancera-red.png', true, 30),
  ('Matcha Meditation', 'Aromatic', 74, null, 'Matcha, green tea, white musk', 'A refined aromatic fragrance, herbal and green, with a calm, polished finish.', 'matcha-meditation.png', false, 130),
  ('Nebras', 'Oriental', 58, null, 'Amber, vanilla, warm spices', 'A rich, enveloping fragrance with amber and spice that lingers beautifully on skin.', 'nebras.png', false, 131),
  ('North Atlantic', 'Fresh', 82, null, 'Citrus, sea breeze, white musk', 'A clean, airy eau de parfum with a bright opening and a soft, lasting dry-down.', 'north-atlantic.png', false, 132),
  ('North Ramz', 'Woody', 68, null, 'Cedar, vetiver, amber', 'A warm, grounded blend of woods and amber, made for evenings and cooler days.', 'north-ramz.png', false, 133),
  ('Old Book', 'Woody', 44, null, 'Paper, vetiver, dry woods', 'A warm, grounded blend of woods and amber, made for evenings and cooler days.', 'old-book.png', false, 134),
  ('Ombré Leather', 'Woody', 148, null, 'Leather, smoke, amber', 'A warm, grounded blend of woods and amber, made for evenings and cooler days.', 'ombre-leather.png', false, 135),
  ('Persian Garden', 'Floral', 104, 'Staff pick', 'Jasmine, rose, soft musk', 'An elegant floral composition, soft and radiant from the first spray to the last.', 'persian-garden.png', true, 37),
  ('Q DG', 'Fresh', 98, null, 'Citrus, sea breeze, white musk', 'A clean, airy eau de parfum with a bright opening and a soft, lasting dry-down.', 'q-dg.png', false, 137),
  ('Royal Water', 'Fresh', 168, 'Staff pick', 'Citrus, sea breeze, white musk', 'A clean, airy eau de parfum with a bright opening and a soft, lasting dry-down.', 'royal-water.png', true, 39),
  ('Salt Air', 'Fresh', 46, null, 'Sea salt, driftwood, citrus', 'A clean, airy eau de parfum with a bright opening and a soft, lasting dry-down.', 'salt-air.png', false, 139),
  ('Sawdust', 'Woody', 44, null, 'Cedar, sawdust, soft musk', 'A warm, grounded blend of woods and amber, made for evenings and cooler days.', 'sawdust.png', false, 140),
  ('Sea Good', 'Fresh', 58, null, 'Citrus, sea breeze, white musk', 'A clean, airy eau de parfum with a bright opening and a soft, lasting dry-down.', 'sea-good.png', false, 141),
  ('Soie', 'Floral', 96, null, 'Jasmine, rose, soft musk', 'An elegant floral composition, soft and radiant from the first spray to the last.', 'soie.png', false, 142),
  ('Sweet Cherry', 'Sweet', 52, null, 'Sweet cherry, caramel, musk', 'A playful, gourmand fragrance that is creamy, sweet and easy to wear every day.', 'sweet-cherry.png', false, 143),
  ('Turathi Blue', 'Fresh', 72, null, 'Citrus, sea breeze, white musk', 'A clean, airy eau de parfum with a bright opening and a soft, lasting dry-down.', 'turathi-blue.png', false, 144),
  ('Ultra Male', 'Sweet', 118, null, 'Vanilla, ripe fruit, creamy musk', 'A playful, gourmand fragrance that is creamy, sweet and easy to wear every day.', 'ultra-male.png', false, 145),
  ('Una Tira Altra', 'Oriental', 76, null, 'Amber, vanilla, warm spices', 'A rich, enveloping fragrance with amber and spice that lingers beautifully on skin.', 'una-tira-altra.png', false, 146),
  ('Velvet Petals', 'Floral', 82, null, 'Jasmine, rose, soft musk', 'An elegant floral composition, soft and radiant from the first spray to the last.', 'velvet-petals.png', false, 147),
  ('Viktor & Rolf Spicebomb', 'Spicy', 132, 'Best seller', 'Pepper, tobacco, smoky amber', 'A bold, confident scent with a spicy heart and a smoky, sensual base.', 'viktor-and-rolf-spicebomb.png', true, 49),
  ('Violette', 'Floral', 78, null, 'Jasmine, rose, soft musk', 'An elegant floral composition, soft and radiant from the first spray to the last.', 'violette.png', false, 149)
on conflict (name) do update set
  category = excluded.category, price = excluded.price, badge = excluded.badge, notes = excluded.notes,
  description = excluded.description, image_path = excluded.image_path, featured = excluded.featured,
  sort_order = excluded.sort_order, is_active = true;