create or replace function public.admin_dashboard()
returns json language plpgsql security definer set search_path = public
as $$
declare result json;
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;

  select json_build_object(
    'orders_total', (select count(*) from public.orders),
    'orders_today', (select count(*) from public.orders
                      where (created_at at time zone 'Asia/Manila')::date = (now() at time zone 'Asia/Manila')::date),
    'pending',      (select count(*) from public.orders where status = 'pending'),
    'revenue',      (select coalesce(sum(total), 0) from public.orders where status <> 'cancelled'),
    'customers',    (select count(*) from public.profiles where role = 'customer'),
    'by_status',    (select coalesce(json_object_agg(s.status, s.n), '{}'::json)
                       from (select status, count(*) as n from public.orders group by status) s),
    'daily', (
      select json_agg(json_build_object('day', to_char(g.d, 'Mon DD'),
                                        'orders', coalesce(c.n, 0),
                                        'revenue', coalesce(c.r, 0)) order by g.d)
        from (select generate_series((now() at time zone 'Asia/Manila')::date - 13,
                                     (now() at time zone 'Asia/Manila')::date, interval '1 day')::date as d) g
        left join (select (created_at at time zone 'Asia/Manila')::date as day, count(*) as n, sum(total) as r
                     from public.orders where status <> 'cancelled' group by 1) c on c.day = g.d
    ),
    'top_products', (
      select coalesce(json_agg(t), '[]'::json) from (
        select oi.product_name as name, sum(oi.qty)::int as units, sum(oi.qty * oi.unit_price) as revenue
          from public.order_items oi join public.orders o on o.id = oi.order_id
         where o.status <> 'cancelled'
         group by oi.product_name order by units desc limit 5) t
    )
  ) into result;

  return result;
end;
$$;
revoke all on function public.admin_dashboard() from public;
grant execute on function public.admin_dashboard() to authenticated;
