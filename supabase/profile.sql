alter table public.profiles
  add column if not exists phone        text,
  add column if not exists address_line text,
  add column if not exists city         text,
  add column if not exists province     text,
  add column if not exists postal_code  text;

alter table public.orders
  add column if not exists ship_name     text,
  add column if not exists ship_phone    text,
  add column if not exists ship_address  text,
  add column if not exists ship_city     text,
  add column if not exists ship_province text,
  add column if not exists ship_postal   text;

create or replace function public.check_shipping(
  p_name text, p_phone text, p_address text, p_city text, p_province text, p_postal text)
returns void language plpgsql
as $$
begin
  if char_length(trim(coalesce(p_name, ''))) not between 2 and 100 then raise exception 'Please enter your full name.'; end if;
  if trim(coalesce(p_phone, '')) !~ '^[-0-9+() ]{7,20}$' then raise exception 'Please enter a valid phone number.'; end if;
  if char_length(trim(coalesce(p_address, ''))) not between 5 and 200 then raise exception 'Please enter your street address.'; end if;
  if char_length(trim(coalesce(p_city, ''))) not between 2 and 100 then raise exception 'Please enter your city or municipality.'; end if;
  if char_length(trim(coalesce(p_province, ''))) not between 2 and 100 then raise exception 'Please enter your province.'; end if;
  if trim(coalesce(p_postal, '')) !~ '^[A-Za-z0-9 -]{3,10}$' then raise exception 'Please enter a valid postal code.'; end if;
end;
$$;
revoke all on function public.check_shipping(text, text, text, text, text, text) from public, anon, authenticated;

create or replace function public.update_profile(
  p_full_name text, p_phone text, p_address_line text, p_city text, p_province text, p_postal_code text)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Please sign in.'; end if;
  perform public.check_shipping(p_full_name, p_phone, p_address_line, p_city, p_province, p_postal_code);
  update public.profiles set
    full_name = trim(p_full_name), phone = trim(p_phone), address_line = trim(p_address_line),
    city = trim(p_city), province = trim(p_province), postal_code = trim(p_postal_code)
  where id = auth.uid();
end;
$$;
revoke all on function public.update_profile(text, text, text, text, text, text) from public;
grant execute on function public.update_profile(text, text, text, text, text, text) to authenticated;

drop function if exists public.place_order(jsonb);

create or replace function public.place_order(p_items jsonb, p_shipping jsonb)
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

  perform public.check_shipping(
    p_shipping->>'full_name', p_shipping->>'phone', p_shipping->>'address_line',
    p_shipping->>'city', p_shipping->>'province', p_shipping->>'postal_code');

  if (select coalesce(sum((i->>'qty')::int), 0) from jsonb_array_elements(p_items) i) > 10 then
    raise exception 'You can order up to 10 bottles at a time.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) i
             group by i->>'name' having sum((i->>'qty')::int) > 5) then
    raise exception 'You can order up to 5 of the same fragrance.';
  end if;

  insert into public.orders (user_id, ship_name, ship_phone, ship_address, ship_city, ship_province, ship_postal)
  values (v_uid, trim(p_shipping->>'full_name'), trim(p_shipping->>'phone'), trim(p_shipping->>'address_line'),
          trim(p_shipping->>'city'), trim(p_shipping->>'province'), trim(p_shipping->>'postal_code'))
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'qty')::int;
    if v_qty is null or v_qty < 1 or v_qty > 5 then raise exception 'Invalid quantity.'; end if;
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
revoke all on function public.place_order(jsonb, jsonb) from public;
grant execute on function public.place_order(jsonb, jsonb) to authenticated;