// POST /api/subscribe  { "email": "..." }  -> saves to Supabase via the subscribe_newsletter() function
export async function POST(request) {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  if (!url || !key) return Response.json({ error: "The server is not configured yet." }, { status: 500 });

  let body = {};
  try { body = await request.json(); } catch {}
  const email = String(body.email || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return Response.json({ error: "Please enter a valid email address." }, { status: 400 });
  }

  try {
    const r = await fetch(`${url}/rest/v1/rpc/subscribe_newsletter`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ p_email: email }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data) {
      console.error("Supabase error", r.status, data);
      return Response.json({ error: "We could not save your subscription. Please try again." }, { status: 502 });
    }
    return Response.json(data);
  } catch (err) {
    console.error(err);
    return Response.json({ error: "We could not reach the database. Please try again." }, { status: 502 });
  }
}
