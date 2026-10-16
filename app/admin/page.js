"use client";

import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";

export default function AdminPage() {
  const [status, setStatus] = useState("loading"); // loading | signedout | denied | error | ready
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState("");

  const load = async () => {
    setStatus("loading");
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return setStatus("signedout");

    const { data: me } = await supabase.from("profiles").select("role").eq("id", session.user.id).single();
    if (me?.role !== "admin") return setStatus("denied");

    // The database itself only returns rows to admins (row-level security).
    const { data, error } = await supabase
      .from("orders")
      .select("order_no, status, total, created_at, profiles(email, full_name), order_items(product_name, qty, unit_price)")
      .order("created_at", { ascending: false });
    if (error) { setError(error.message); return setStatus("error"); }
    setOrders(data);
    setStatus("ready");
  };

  useEffect(() => { load(); }, []);

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

  const signOut = async () => { await supabase.auth.signOut(); load(); };

  const messages = {
    loading: "Loading…",
    signedout: "You are not signed in. Go back to the store and use Sign in with your admin account.",
    denied: "This page is for administrators only.",
    error: "Could not load orders: " + error,
  };

  return (
    <div className="adm">
      <style>{`
        .adm{--ink:#121210; --panel:#1a1a17; --gold:#c9a24b; --gold-soft:#d9be7f; --gold-line:rgba(201,162,75,0.35);
          --cream:#f3ede1; --cream-dim:#c9c3b4; --stone:#8f8a7c;
          min-height:100vh; background:var(--ink); color:var(--cream); font-family:'Jost',sans-serif; font-weight:300; padding:40px;}
        .adm-wrap{max-width:1100px; margin:0 auto;}
        .adm-head{display:flex; justify-content:space-between; align-items:flex-end; border-bottom:1px solid var(--gold-line); padding-bottom:22px; margin-bottom:28px;}
        .adm-eyebrow{font-size:11px; letter-spacing:0.35em; text-transform:uppercase; color:var(--gold-soft);}
        .adm h1{font-family:'Cormorant Garamond',serif; font-weight:500; font-size:38px; margin:8px 0 0;}
        .adm-actions{display:flex; gap:14px; align-items:center;}
        .adm-actions a,.adm-actions button{font-family:'Jost',sans-serif; font-size:11px; letter-spacing:0.14em; text-transform:uppercase;
          color:var(--cream); background:none; border:1px solid var(--gold-line); padding:9px 16px; cursor:pointer; text-decoration:none;}
        .adm-actions a:hover,.adm-actions button:hover{border-color:var(--gold); color:var(--gold-soft);}
        .adm-msg{color:var(--cream-dim); font-size:14px; padding:40px 0;}
        .adm-scroll{overflow-x:auto;}
        .adm table{width:100%; min-width:720px; border-collapse:collapse; background:var(--panel); border:1px solid var(--gold-line);}
        .adm th{text-align:left; font-size:10px; letter-spacing:0.2em; text-transform:uppercase; color:var(--gold-soft); font-weight:400; padding:14px 16px; border-bottom:1px solid var(--gold-line);}
        .adm td{font-size:13px; color:var(--cream-dim); padding:14px 16px; border-bottom:1px solid rgba(201,162,75,0.15); vertical-align:top;}
        .adm td.no{font-family:'Cormorant Garamond',serif; font-size:18px; color:var(--cream);}
        .adm select{background:var(--ink); color:var(--cream); border:1px solid var(--gold-line); padding:6px 10px; font-family:'Jost',sans-serif; font-size:13px;}
        .adm td.total{font-family:'Cormorant Garamond',serif; font-size:18px; color:var(--gold-soft);}
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
            <h1>Orders</h1>
          </div>
          <div className="adm-actions">
            <a href="/">Back to store</a>
            <button onClick={load}>Refresh</button>
            <button onClick={signOut}>Sign out</button>
          </div>
        </div>

        {status !== "ready" ? (
          <p className="adm-msg">{messages[status]}</p>
        ) : orders.length === 0 ? (
          <p className="adm-msg">No orders yet.</p>
        ) : (
          <div className="adm-scroll">
            <table>
              <thead>
                <tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th>Placed</th></tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.order_no}>
                    <td className="no">{o.order_no}</td>
                    <td>{o.profiles?.full_name || "—"}<br />{o.profiles?.email}</td>
                    <td>{o.order_items.map((i) => `${i.product_name} × ${i.qty}`).join(", ")}</td>
                    <td className="total">${o.total}</td>
                    <td>
                      <select value={o.status} onChange={(e) => changeStatus(o.order_no, e.target.value)}>
                        {[...new Set(["pending", "shipped", "delivered", o.status])].map((s) => (
                          <option key={s} value={s}>{s}</option>
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
      </div>
    </div>
  );
}