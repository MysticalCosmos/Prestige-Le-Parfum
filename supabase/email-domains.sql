create or replace function public.enforce_email_domain()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if not (lower(split_part(new.email, '@', 2)) = any (array[
    'gmail.com',
    'yahoo.com', 'yahoo.com.ph',
    'outlook.com', 'outlook.ph', 'hotmail.com', 'live.com',
    'icloud.com',
    'proton.me', 'protonmail.com',
    'tip.edu.ph'
  ])) then
    raise exception 'This email provider is not supported.';
  end if;
  return new;
end;
$$;