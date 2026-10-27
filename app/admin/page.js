"use client";

import { useEffect, useState } from "react";
import { supabase, setRemember } from "../../lib/supabase";

const STATUSES = ["pending", "shipped", "delivered"];
const PAGE_SIZE = 50;
const CATEGORIES = ["Fresh", "Woody", "Oriental", "Floral", "Sweet", "Spicy", "Aromatic"];
const BLANK_PRODUCT = { id: null, name: "", category: "", price: "", badge: "", notes: "", description: "", featured: false, is_active: true, image_path: null, file: null };
const slugify = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const imageUrl = (path) => (path ? supabase.storage.from("products").getPublicUrl(path).data.publicUrl : null);
const money = (n) => "$" + Number(n || 0).toLocaleString();
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s); // pending -> Pending (display only)
const ORDER_COLUMNS =
  "order_no, status, total, created_at, ship_name, ship_phone, ship_address, ship_city, ship_province, ship_postal, profiles(email, full_name), order_items(product_name, qty, unit_price)";

export default function AdminPage() {
  const [status, setStatus] = useState("loading"); // loading | signedout | denied | error | ready
  const [tab, setTab] = useState("dashboard"); // dashboard | orders | users
  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState("");
  const [orders, setOrders] = useState([]);
  const [orderCount, setOrderCount] = useState(0);
  const [statusFilter, setStatusFilter] = useState("all");
  const [moreBusy, setMoreBusy] = useState(false);
  const [users, setUsers] = useState([]);
  const [usersError, setUsersError] = useState("");
  const [query, setQuery] = useState("");
  const [meId, setMeId] = useState(null);
  const [error, setError] = useState("");
  const [products, setProducts] = useState([]);
  const [productsError, setProductsError] = useState("");
  const [prodForm, setProdForm] = useState(null); // null = form closed
  const [prodMsg, setProdMsg] = useState("");
  const [prodBusy, setProdBusy] = useState(false);
  const [prodQuery, setProdQuery] = useState("");

  const fetchOrders = (filter, from) => {
    let q = supabase
      .from("orders")
      .select(ORDER_COLUMNS, { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (filter !== "all") q = q.eq("status", filter);
    return q;
  };

  const load = async () => {
    setStatus("loading");
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return setStatus("signedout");
    setMeId(session.user.id);

    const { data: me } = await supabase.from("profiles").select("role").eq("id", session.user.id).single();
    if (me?.role !== "admin") return setStatus("denied");

    // The database itself only returns this data to admins (row-level security).
    const [ordersRes, usersRes, statsRes, prodRes] = await Promise.all([
      fetchOrders(statusFilter, 0),
      supabase.rpc("admin_list_users"),
      supabase.rpc("admin_dashboard"),
      supabase.from("products").select("*").order("sort_order", { ascending: true }).order("name", { ascending: true }),
    ]);
    if (ordersRes.error) { setError(ordersRes.error.message); return setStatus("error"); }
    setOrders(ordersRes.data);
    setOrderCount(ordersRes.count ?? ordersRes.data.length);
    setUsers(usersRes.data || []);
    setUsersError(usersRes.error ? usersRes.error.message : "");
    setStats(statsRes.data || null);
    setStatsError(statsRes.error ? statsRes.error.message : "");
    setProducts(prodRes.data || []);
    setProductsError(prodRes.error ? prodRes.error.message : "");
    setStatus("ready");
  };

  useEffect(() => { load(); }, []);

  const changeFilter = async (f) => {
    setStatusFilter(f);
    const res = await fetchOrders(f, 0);
    if (res.error) return alert(res.error.message);
    setOrders(res.data);
    setOrderCount(res.count ?? res.data.length);
  };

  const loadMore = async () => {
    setMoreBusy(true);
    const res = await fetchOrders(statusFilter, orders.length);
    setMoreBusy(false);
    if (res.error) return alert(res.error.message);
    setOrders((list) => [...list, ...res.data]);
  };

  const changeStatus = async (orderNo, newStatus) => {
    const { data, error } = await supabase
      .from("orders")
      .update({ status: newStatus })
      .eq("order_no", orderNo)
      .select("order_no");
    if (error || !data || data.length === 0) {
      alert("Could not update the status: " + (error?.message || "no permission. Did you run tracking.sql?"));
      return;
    }
    setOrders((list) => list.map((o) => (o.order_no === orderNo ? { ...o, status: newStatus } : o)));
  };

  const changeRole = async (u) => {
    const newRole = u.role === "admin" ? "customer" : "admin";
    if (!window.confirm(`Make ${u.email} ${newRole === "admin" ? "an admin" : "a customer"}?`)) return;
    const { error } = await supabase.rpc("admin_set_user_role", { p_user_id: u.id, p_role: newRole });
    if (error) return alert(error.message);
    setUsers((list) => list.map((x) => (x.id === u.id ? { ...x, role: newRole } : x)));
  };

  const toggleActive = async (u) => {
    const disable = !u.is_disabled;
    if (!window.confirm(`${disable ? "Disable" : "Enable"} the account ${u.email}?`)) return;
    const { error } = await supabase.rpc("admin_set_user_active", { p_user_id: u.id, p_active: !disable });
    if (error) return alert(error.message);
    setUsers((list) => list.map((x) => (x.id === u.id ? { ...x, is_disabled: disable } : x)));
  };

  /* ---------------- Products: add / edit / hide / feature / delete ---------------- */
  const setPF = (key, value) => setProdForm((f) => ({ ...f, [key]: value }));
  const openAdd = () => { setProdMsg(""); setProdForm({ ...BLANK_PRODUCT }); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const openEdit = (p) => {
    setProdMsg("");
    setProdForm({
      id: p.id, name: p.name, category: p.category || "", price: String(p.price), badge: p.badge || "",
      notes: p.notes || "", description: p.description || "", featured: !!p.featured, is_active: !!p.is_active,
      image_path: p.image_path || null, file: null,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const saveProduct = async (e) => {
    e.preventDefault();
    if (prodBusy) return;
    const f = prodForm;
    const name = f.name.trim();
    const price = Number(f.price);
    if (name.length < 2 || name.length > 80) return setProdMsg("The name must be 2 to 80 characters.");
    if (!f.category) return setProdMsg("Please choose a category.");
    if (!(price > 0) || price > 100000) return setProdMsg("Please enter a valid price.");
    if (f.file && f.file.size > 5 * 1024 * 1024) return setProdMsg("The photo must be under 5 MB. Please compress it first.");

    setProdBusy(true);
    setProdMsg("Saving…");
    let imagePath = f.image_path;
    const oldImage = f.image_path;
    if (f.file) {
      const ext = (f.file.name.split(".").pop() || "png").toLowerCase();
      if (!["png", "jpg", "jpeg", "webp", "avif"].includes(ext)) {
        setProdBusy(false);
        return setProdMsg("Photos must be PNG, JPG, WEBP or AVIF.");
      }
      imagePath = `${slugify(name) || "product"}-${Date.now().toString(36)}.${ext}`;
      const up = await supabase.storage.from("products").upload(imagePath, f.file, { contentType: f.file.type });
      if (up.error) {
        setProdBusy(false);
        return setProdMsg("Photo upload failed: " + up.error.message);
      }
    }
    const row = {
      name, category: f.category, price, badge: f.badge.trim() || null, notes: f.notes.trim() || null,
      description: f.description.trim() || null, featured: f.featured, is_active: f.is_active, image_path: imagePath,
    };
    const res = f.id
      ? await supabase.from("products").update(row).eq("id", f.id).select()
      : await supabase.from("products").insert(row).select();
    setProdBusy(false);
    if (res.error || !res.data?.length) {
      const msg = res.error?.message || "no permission. Did you run products.sql?";
      return setProdMsg(/duplicate|unique/i.test(msg) ? "A product with that name already exists." : "Could not save: " + msg);
    }
    if (f.file && oldImage && oldImage !== imagePath) supabase.storage.from("products").remove([oldImage]);
    const saved = res.data[0];
    setProducts((list) => (f.id ? list.map((x) => (x.id === saved.id ? saved : x)) : [saved, ...list]));
    setProdForm(null);
    setProdMsg("");
  };

  const toggleProductFlag = async (p, field) => {
    const { data, error } = await supabase.from("products").update({ [field]: !p[field] }).eq("id", p.id).select();
    if (error || !data?.length) return alert("Could not update: " + (error?.message || "no permission"));
    setProducts((list) => list.map((x) => (x.id === p.id ? data[0] : x)));
  };

  const deleteProduct = async (p) => {
    if (!window.confirm(`Delete "${p.name}"? Past orders keep their record. To only remove it from the store, use Hide instead.`)) return;
    const { error } = await supabase.from("products").delete().eq("id", p.id);
    if (error) return alert("Could not delete: " + error.message);
    if (p.image_path) supabase.storage.from("products").remove([p.image_path]);
    setProducts((list) => list.filter((x) => x.id !== p.id));
  };

  const signOut = async () => {
    if (!window.confirm("Sign out of the admin panel?")) return;
    await supabase.auth.signOut();
    setRemember(false);
    load();
  };

  const messages = {
    loading: "Loading…",
    signedout: "You are not signed in. Go back to the store and use Sign in with your admin account.",
    denied: "This page is for administrators only.",
    error: "Could not load orders: " + error,
  };

  const q = query.trim().toLowerCase();
  const shownUsers = users.filter(
    (u) => !q || (u.email || "").toLowerCase().includes(q) || (u.full_name || "").toLowerCase().includes(q)
  );
  const daily = stats?.daily || [];
  const maxDaily = Math.max(1, ...daily.map((d) => d.orders));
  const byStatus = stats?.by_status || {};
  const avgOrder = stats && stats.orders_total > 0 ? stats.revenue / stats.orders_total : 0;

  return (
    <div className="adm">
      <style>{`
        .adm{--ink:#121210; --panel:#1a1a17; --gold:#c9a24b; --gold-soft:#d9be7f; --gold-line:rgba(201,162,75,0.35);
          --cream:#f3ede1; --cream-dim:#c9c3b4; --stone:#8f8a7c;
          min-height:100vh; background:var(--ink); color:var(--cream); font-family:'Jost',sans-serif; font-weight:300; padding:40px;}
        .adm-wrap{max-width:1100px; margin:0 auto;}
        .adm-head{display:flex; justify-content:space-between; align-items:flex-end; border-bottom:1px solid var(--gold-line); padding-bottom:22px; margin-bottom:24px;}
        .adm-eyebrow{font-size:11px; letter-spacing:0.35em; text-transform:uppercase; color:var(--gold-soft);}
        .adm h1{font-family:'Cormorant Garamond',serif; font-weight:500; font-size:38px; margin:8px 0 0;}
        .adm h2{font-family:'Cormorant Garamond',serif; font-weight:500; font-size:22px; margin:0 0 16px;}
        .adm-actions{display:flex; gap:14px; align-items:center;}
        .adm-actions a,.adm-actions button,.adm-tabs button,.adm-row-actions button,.adm-more{font-family:'Jost',sans-serif; font-size:11px; letter-spacing:0.14em; text-transform:uppercase;
          color:var(--cream); background:none; border:1px solid var(--gold-line); padding:9px 16px; cursor:pointer; text-decoration:none;}
        .adm-actions a:hover,.adm-actions button:hover,.adm-tabs button:hover,.adm-row-actions button:hover,.adm-more:hover{border-color:var(--gold); color:var(--gold-soft);}
        .adm-tabs{display:flex; gap:10px; margin-bottom:22px; flex-wrap:wrap;}
        .adm-tabs button.on{border-color:var(--gold); color:var(--gold-soft);}
        .adm-search{width:100%; max-width:360px; margin-bottom:18px; background:var(--panel); border:1px solid var(--gold-line); color:var(--cream);
          font-family:'Jost',sans-serif; font-size:14px; padding:11px 14px; outline:none;}
        .adm-search:focus{border-color:var(--gold);}
        .adm-msg{color:var(--cream-dim); font-size:14px; padding:40px 0;}
        .adm-scroll{overflow-x:auto;}
        .adm table{width:100%; min-width:720px; border-collapse:collapse; background:var(--panel); border:1px solid var(--gold-line);}
        .adm table.wide{min-width:940px;}
        .adm th{text-align:left; font-size:10px; letter-spacing:0.2em; text-transform:uppercase; color:var(--gold-soft); font-weight:400; padding:14px 16px; border-bottom:1px solid var(--gold-line);}
        .adm td{font-size:13px; color:var(--cream-dim); padding:14px 16px; border-bottom:1px solid rgba(201,162,75,0.15); vertical-align:top;}
        .adm td.no{font-family:'Cormorant Garamond',serif; font-size:18px; color:var(--cream);}
        .adm select{background:var(--ink); color:var(--cream); border:1px solid var(--gold-line); padding:6px 10px; font-family:'Jost',sans-serif; font-size:13px;}
        .adm td.total{font-family:'Cormorant Garamond',serif; font-size:18px; color:var(--gold-soft);}
        .adm-badge{display:inline-block; font-size:10px; letter-spacing:0.14em; text-transform:uppercase; padding:3px 8px; border:1px solid var(--gold-line);}
        .adm-badge.admin{color:var(--gold-soft); border-color:var(--gold);}
        .adm-badge.off{color:#e0907f; border-color:#e0907f;}
        .adm-row-actions{display:flex; gap:8px; flex-wrap:wrap;}
        .adm-row-actions button{padding:7px 11px; font-size:10px;}
        .adm-bar-tools{display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:16px; font-size:13px; color:var(--stone);}
        .adm-more{display:block; margin:20px auto 0;}
        /* dashboard */
        .adm-kpis{display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:14px; margin-bottom:28px;}
        .adm-kpi{background:var(--panel); border:1px solid var(--gold-line); padding:18px 18px 16px;}
        .adm-kpi small{display:block; font-size:10px; letter-spacing:0.2em; text-transform:uppercase; color:var(--stone); margin-bottom:10px;}
        .adm-kpi b{font-family:'Cormorant Garamond',serif; font-weight:500; font-size:34px; color:var(--gold-soft);}
        .adm-grid2{display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px;}
        .adm-card{background:var(--panel); border:1px solid var(--gold-line); padding:22px;}
        .adm-bars{display:flex; gap:6px; height:150px;}
        .adm-bar-col{flex:1; display:flex; flex-direction:column; align-items:center; gap:6px; font-size:10px; color:var(--stone);}
        .adm-bar-wrap{flex:1; width:100%; display:flex; align-items:flex-end;}
        .adm-bar{width:100%; background:var(--gold); min-height:2px;}
        .adm-hbar{display:grid; grid-template-columns:90px 1fr 40px; gap:12px; align-items:center; font-size:13px; color:var(--cream-dim); margin-bottom:12px;}
        .adm-hbar div{height:6px; background:rgba(201,162,75,0.15);}
        .adm-hbar i{display:block; height:100%; background:var(--gold);}
        .adm-hbar b{text-align:right; font-weight:400; color:var(--cream);}
        .adm-top{display:flex; justify-content:space-between; gap:12px; padding:9px 0; border-bottom:1px solid rgba(201,162,75,0.15); font-size:13px; color:var(--cream-dim);}
        .adm-top:last-child{border-bottom:none;}
        .adm-note{font-size:12px; color:var(--stone); margin-top:14px;}
        .adm-thumb{width:46px; height:60px; object-fit:contain; background:#fff; display:block;}
        .adm-thumb.ph{display:flex; align-items:center; justify-content:center; font-size:9px; color:#777; text-align:center;}
        .adm-thumb.inline{display:inline-block; vertical-align:middle; margin-left:8px;}
        .adm-form{margin-bottom:22px;}
        .adm-fields{display:grid; grid-template-columns:1fr 1fr; gap:14px;}
        .adm-fields label{display:flex; flex-direction:column; gap:6px; font-size:11px; letter-spacing:0.14em; text-transform:uppercase; color:var(--stone);}
        .adm-fields label.wide{grid-column:1 / -1;}
        .adm-fields input,.adm-fields select,.adm-fields textarea{background:var(--ink); border:1px solid var(--gold-line); color:var(--cream); font-family:'Jost',sans-serif;
          font-size:14px; letter-spacing:normal; text-transform:none; padding:10px 12px; outline:none;}
        .adm-fields input:focus,.adm-fields select:focus,.adm-fields textarea:focus{border-color:var(--gold);}
        .adm-checks{display:flex; gap:22px; flex-wrap:wrap; margin:16px 0; font-size:13px; color:var(--cream-dim);}
        .adm-checks label{display:flex; gap:8px; align-items:center; cursor:pointer;}
        @media (max-width:800px){ .adm-grid2{grid-template-columns:1fr;} .adm-fields{grid-template-columns:1fr;} }
        @media (max-width:600px){
          .adm{padding:20px 16px;}
          .adm-head{flex-direction:column; align-items:flex-start; gap:16px;}
          .adm h1{font-size:30px;}
          .adm-actions{flex-wrap:wrap;}
        }
      `}</style>
      <div className="adm-wrap">
        <div className="adm-head">
          <div>
            <div className="adm-eyebrow">Prestige Le Parfum</div>
            <h1>Admin</h1>
          </div>
          <div className="adm-actions">
            {/* admins never see the customer storefront; only visitors who are not admins get this link */}
            {status !== "ready" && <a href="/">Back to store</a>}
            <button onClick={load}>Refresh</button>
            <button onClick={signOut}>Sign out</button>
          </div>
        </div>

        {status !== "ready" ? (
          <p className="adm-msg">{messages[status]}</p>
        ) : (
          <>
            <div className="adm-tabs">
              <button className={tab === "dashboard" ? "on" : ""} onClick={() => setTab("dashboard")}>Dashboard</button>
              <button className={tab === "orders" ? "on" : ""} onClick={() => setTab("orders")}>Orders ({stats ? stats.orders_total : orderCount})</button>
              <button className={tab === "products" ? "on" : ""} onClick={() => setTab("products")}>Products ({products.length})</button>
              <button className={tab === "users" ? "on" : ""} onClick={() => setTab("users")}>Users ({users.length})</button>
            </div>

            {tab === "dashboard" &&
              (statsError || !stats ? (
                <p className="adm-msg">Could not load the dashboard: {statsError || "no data"}. Did you run admin-dashboard.sql in Supabase?</p>
              ) : (
                <>
                  <div className="adm-kpis">
                    <div className="adm-kpi"><small>Revenue</small><b>{money(stats.revenue)}</b></div>
                    <div className="adm-kpi"><small>Orders</small><b>{stats.orders_total}</b></div>
                    <div className="adm-kpi"><small>Pending</small><b>{stats.pending}</b></div>
                    <div className="adm-kpi"><small>Orders today</small><b>{stats.orders_today}</b></div>
                    <div className="adm-kpi"><small>Customers</small><b>{stats.customers}</b></div>
                    <div className="adm-kpi"><small>Average order</small><b>{money(Math.round(avgOrder))}</b></div>
                  </div>

                  <div className="adm-grid2">
                    <div className="adm-card">
                      <h2>Orders by Status</h2>
                      {Object.keys(byStatus).length === 0 && <p className="adm-msg" style={{ padding: 0 }}>No orders yet.</p>}
                      {Object.entries(byStatus).map(([k, n]) => (
                        <div className="adm-hbar" key={k}>
                          <span>{cap(k)}</span>
                          <div><i style={{ width: `${(n / Math.max(1, stats.orders_total)) * 100}%` }} /></div>
                          <b>{n}</b>
                        </div>
                      ))}
                    </div>
                    <div className="adm-card">
                      <h2>Top Sellers</h2>
                      {stats.top_products.length === 0 && <p className="adm-msg" style={{ padding: 0 }}>No sales yet.</p>}
                      {stats.top_products.map((p) => (
                        <div className="adm-top" key={p.name}>
                          <span>{p.name}</span>
                          <span>{p.units} sold · {money(p.revenue)}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="adm-card">
                    <h2>Orders, Last 14 Days</h2>
                    <div className="adm-bars">
                      {daily.map((d) => (
                        <div className="adm-bar-col" key={d.day} title={`${d.day}: ${d.orders} orders, ${money(d.revenue)}`}>
                          <div className="adm-bar-wrap">
                            <div className="adm-bar" style={{ height: `${(d.orders / maxDaily) * 100}%` }} />
                          </div>
                          <span>{d.day.split(" ")[1]}</span>
                        </div>
                      ))}
                    </div>
                    <p className="adm-note">Revenue and daily counts leave out cancelled orders. Days use Philippine time.</p>
                  </div>
                </>
              ))}

            {tab === "orders" && (
              <>
                <div className="adm-bar-tools">
                  <label>
                    Status{" "}
                    <select value={statusFilter} onChange={(e) => changeFilter(e.target.value)}>
                      <option value="all">All</option>
                      {STATUSES.map((s) => (<option key={s} value={s}>{cap(s)}</option>))}
                    </select>
                  </label>
                  <span>Showing {orders.length} of {orderCount}</span>
                </div>
                {orders.length === 0 ? (
                  <p className="adm-msg">No orders found.</p>
                ) : (
                  <div className="adm-scroll">
                    <table>
                      <thead>
                        <tr><th>Order</th><th>Customer / Ship to</th><th>Items</th><th>Total</th><th>Status</th><th>Placed</th></tr>
                      </thead>
                      <tbody>
                        {orders.map((o) => (
                          <tr key={o.order_no}>
                            <td className="no">{o.order_no}</td>
                            <td>
                              {o.ship_name || o.profiles?.full_name || "—"}<br />{o.profiles?.email}
                              {o.ship_address && (
                                <>
                                  <br />{o.ship_phone}
                                  <br />{o.ship_address}, {o.ship_city}, {o.ship_province} {o.ship_postal}
                                </>
                              )}
                            </td>
                            <td>{o.order_items.map((i) => `${i.product_name} × ${i.qty}`).join(", ")}</td>
                            <td className="total">${o.total}</td>
                            <td>
                              <select value={o.status} onChange={(e) => changeStatus(o.order_no, e.target.value)}>
                                {[...new Set([...STATUSES, o.status])].map((s) => (
                                  <option key={s} value={s}>{cap(s)}</option>
                                ))}
                              </select>
                            </td>
                            <td>{new Date(o.created_at).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {orders.length < orderCount && (
                  <button className="adm-more" onClick={loadMore} disabled={moreBusy}>
                    {moreBusy ? "Loading…" : "Load 50 more"}
                  </button>
                )}
              </>
            )}

            {tab === "products" &&
              (productsError ? (
                <p className="adm-msg">Could not load products: {productsError}. Did you run products.sql in Supabase?</p>
              ) : (
                <>
                  {prodForm && (
                    <form className="adm-card adm-form" onSubmit={saveProduct}>
                      <h2>{prodForm.id ? "Edit Product" : "Add Product"}</h2>
                      <div className="adm-fields">
                        <label>Name<input value={prodForm.name} onChange={(e) => setPF("name", e.target.value)} /></label>
                        <label>Category
                          <select value={prodForm.category} onChange={(e) => setPF("category", e.target.value)}>
                            <option value="">Choose…</option>
                            {CATEGORIES.map((c) => (<option key={c} value={c}>{c}</option>))}
                          </select>
                        </label>
                        <label>Price ($)<input type="number" min="1" step="0.01" value={prodForm.price} onChange={(e) => setPF("price", e.target.value)} /></label>
                        <label>Badge (optional)<input value={prodForm.badge} placeholder="Best Seller, New, Limited" onChange={(e) => setPF("badge", e.target.value)} /></label>
                        <label className="wide">Scent notes<input value={prodForm.notes} placeholder="Amber, oud, black pepper" onChange={(e) => setPF("notes", e.target.value)} /></label>
                        <label className="wide">Description<textarea rows={3} value={prodForm.description} onChange={(e) => setPF("description", e.target.value)} /></label>
                        <label className="wide">Photo (PNG, JPG, WEBP or AVIF, under 5 MB)
                          <input type="file" accept="image/png,image/jpeg,image/webp,image/avif" onChange={(e) => setPF("file", e.target.files[0] || null)} />
                        </label>
                      </div>
                      {prodForm.image_path && !prodForm.file && (
                        <p className="adm-note">Current photo: <img className="adm-thumb inline" src={imageUrl(prodForm.image_path)} alt="" /></p>
                      )}
                      <div className="adm-checks">
                        <label><input type="checkbox" checked={prodForm.featured} onChange={(e) => setPF("featured", e.target.checked)} /> Featured on the home page</label>
                        <label><input type="checkbox" checked={prodForm.is_active} onChange={(e) => setPF("is_active", e.target.checked)} /> Visible in the store</label>
                      </div>
                      <div className="adm-row-actions">
                        <button type="submit" disabled={prodBusy}>{prodBusy ? "Saving…" : "Save product"}</button>
                        <button type="button" onClick={() => setProdForm(null)}>Cancel</button>
                      </div>
                      {prodMsg && <p className="adm-note">{prodMsg}</p>}
                    </form>
                  )}
                  <div className="adm-bar-tools">
                    <input className="adm-search" style={{ marginBottom: 0 }} type="search" placeholder="Search products" value={prodQuery} onChange={(e) => setProdQuery(e.target.value)} />
                    <button className="adm-more" style={{ margin: 0 }} onClick={openAdd}>+ Add Product</button>
                  </div>
                  <div className="adm-scroll">
                    <table className="wide">
                      <thead>
                        <tr><th>Photo</th><th>Product</th><th>Category</th><th>Price</th><th>Status</th><th>Actions</th></tr>
                      </thead>
                      <tbody>
                        {products
                          .filter((p) => !prodQuery.trim() || p.name.toLowerCase().includes(prodQuery.trim().toLowerCase()) || (p.category || "").toLowerCase().includes(prodQuery.trim().toLowerCase()))
                          .map((p) => (
                            <tr key={p.id}>
                              <td>{p.image_path ? <img className="adm-thumb" src={imageUrl(p.image_path)} alt="" loading="lazy" /> : <span className="adm-thumb ph">No photo</span>}</td>
                              <td>
                                <span style={{ color: "var(--cream)" }}>{p.name}</span>
                                {p.badge && (<><br /><span className="adm-badge">{p.badge}</span></>)}
                              </td>
                              <td>{p.category || "—"}</td>
                              <td className="total">${p.price}</td>
                              <td>
                                {p.is_active ? "Visible" : <span className="adm-badge off">Hidden</span>}
                                {p.featured && (<><br /><span className="adm-badge admin">Featured</span></>)}
                              </td>
                              <td>
                                <div className="adm-row-actions">
                                  <button onClick={() => openEdit(p)}>Edit</button>
                                  <button onClick={() => toggleProductFlag(p, "is_active")}>{p.is_active ? "Hide" : "Show"}</button>
                                  <button onClick={() => toggleProductFlag(p, "featured")}>{p.featured ? "Unfeature" : "Feature"}</button>
                                  <button onClick={() => deleteProduct(p)}>Delete</button>
                                </div>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ))}

            {tab === "users" &&
              (usersError ? (
                <p className="adm-msg">Could not load users: {usersError}. Did you run admin-users.sql in Supabase?</p>
              ) : (
                <>
                  <input
                    className="adm-search"
                    type="search"
                    placeholder="Search by name or email"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {shownUsers.length === 0 ? (
                    <p className="adm-msg">No users match your search.</p>
                  ) : (
                    <div className="adm-scroll">
                      <table className="wide">
                        <thead>
                          <tr><th>User</th><th>Role</th><th>Orders</th><th>Joined</th><th>Last sign-in</th><th>Status</th><th>Actions</th></tr>
                        </thead>
                        <tbody>
                          {shownUsers.map((u) => (
                            <tr key={u.id}>
                              <td>
                                {u.full_name || "—"}<br />{u.email}
                                {u.phone && (<><br />{u.phone}</>)}
                              </td>
                              <td><span className={"adm-badge " + u.role}>{cap(u.role)}</span></td>
                              <td>{u.order_count}</td>
                              <td>{new Date(u.created_at).toLocaleDateString()}</td>
                              <td>{u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString() : "Never"}</td>
                              <td>{u.is_disabled ? <span className="adm-badge off">Disabled</span> : "Active"}</td>
                              <td>
                                {u.id === meId ? (
                                  <em>You</em>
                                ) : (
                                  <div className="adm-row-actions">
                                    <button onClick={() => changeRole(u)}>{u.role === "admin" ? "Make customer" : "Make admin"}</button>
                                    <button onClick={() => toggleActive(u)}>{u.is_disabled ? "Enable" : "Disable"}</button>
                                  </div>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              ))}
          </>
        )}
      </div>
    </div>
  );
}