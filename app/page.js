"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { supabase, setRemember, rememberExpired } from "../lib/supabase";

const MAX_PER_ITEM = 5; // bottles of the same fragrance per order
const MAX_PER_ORDER = 10; // bottles in total per order
const STATUS_LABEL = { pending: "Order received", paid: "Paid", shipped: "Shipped", delivered: "Delivered", cancelled: "Cancelled" };

/* ---------------- Account rules ---------------- */
const ALLOWED_EMAIL = /^[^\s@]+@(gmail\.com|tip\.edu\.ph)$/i; // only these two domains, nothing else
const EMAIL_RULE = "Please use your @gmail.com or @tip.edu.ph email address.";
const PASSWORD_RULE = "Password needs 8+ characters with at least one letter and one number.";
const validPassword = (p) => p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p);

const friendlyAuthError = (error) => {
  const m = (error?.message || "").toLowerCase();
  if (m.includes("invalid login")) return "Incorrect email or password.";
  if (m.includes("database error saving new user")) return EMAIL_RULE; // blocked by the database domain rule
  if (m.includes("already registered")) return "That email is already registered. Try signing in.";
  if (m.includes("rate limit") || (m.includes("after") && m.includes("seconds"))) return "Too many requests. Please wait a minute and try again.";
  return error?.message || "Something went wrong. Please try again.";
};

/* ---------- Reusable bottle SVG (used in hero + product cards) ---------- */
function BottleSVG({ style }) {
  return (
    <svg viewBox="0 0 100 140" fill="none" xmlns="http://www.w3.org/2000/svg" style={style}>
      <path
        d="M40 30 L60 30 L60 42 L68 48 L68 60 L74 55 L82 58 L82 68 L74 66 L68 62 L68 130 Q68 138 60 138 L40 138 Q32 138 32 130 L32 62 L26 66 L18 68 L18 58 L26 55 L32 60 L32 48 L40 42 Z"
        stroke="#c9a24b"
        strokeWidth="1.4"
      />
      <path d="M40 62 L50 130 L60 62" stroke="#c9a24b" strokeWidth="1" opacity="0.55" />
    </svg>
  );
}

function CrestDataUri() {
  return (
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='47' fill='none' stroke='#c9a24b' stroke-width='2'/><text x='50' y='63' font-family='Georgia,serif' font-size='46' fill='#c9a24b' text-anchor='middle'>P</text></svg>`
    )
  );
}

const PRODUCTS = [
  { name: "Noir Royal", badge: "Best seller", notes: "Amber, oud, black pepper", price: 168 },
  { name: "Velours d'Or", badge: null, notes: "Bergamot, iris, sandalwood", price: 154 },
  { name: "Ambre Imperial", badge: "Limited", notes: "Vanilla, cedar, saffron", price: 192 },
  { name: "Soie Blanche", badge: null, notes: "Jasmine, musk, white tea", price: 146 },
];

const BLOG_POSTS = [
  {
    tag: "Fragrance guide",
    title: "How to choose a signature scent",
    excerpt:
      "Notes, layering, and longevity — a short guide to finding the fragrance that becomes yours.",
    infoTitle: "How to choose a signature scent",
    infoBody:
      "Notes, layering, and longevity — a short guide to finding the fragrance that becomes yours. Full article coming soon.",
  },
  {
    tag: "Behind the house",
    title: "Inside our atelier in Grasse",
    excerpt: "A look at how each Prestige Le Parfum batch is blended, rested, and bottled by hand.",
    infoTitle: "Inside our atelier in Grasse",
    infoBody:
      "A look at how each Prestige Le Parfum batch is blended, rested, and bottled by hand. Full article coming soon.",
  },
  {
    tag: "Gifting",
    title: "The art of gifting fragrance",
    excerpt:
      "Our edit of scents to give this season, and how to pair them with the right occasion.",
    infoTitle: "The art of gifting fragrance",
    infoBody:
      "Our edit of scents to give this season, and how to pair them with the right occasion. Full article coming soon.",
  },
];

const STRIP_ITEMS = [
  "Complimentary gift wrapping",
  "Secure checkout",
  "Free shipping over $120",
  "30-day returns",
];

export default function PrestigeLeParfum() {
  const [cart, setCart] = useState([]); // { name, price, qty }
  const [cartOpen, setCartOpen] = useState(false);
  const [openModalId, setOpenModalId] = useState(null); // 'signin' | 'create' | 'tracking' | 'info' | null
  const [info, setInfo] = useState({ title: "Notice", body: "Content coming soon." });
  const [signinMsg, setSigninMsg] = useState("");
  const [createMsg, setCreateMsg] = useState("");
  const [trackingMsg, setTrackingMsg] = useState("");
  const [newsletterMsg, setNewsletterMsg] = useState("");
  const [newsletterEmail, setNewsletterEmail] = useState("");
  const [newsletterLoading, setNewsletterLoading] = useState(false);
  const [newsletterError, setNewsletterError] = useState(false);
  const [user, setUser] = useState(null); // signed-in Supabase user (or null)
  const [role, setRole] = useState(null); // 'customer' | 'admin'
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false); // mobile menu
  const [showPw, setShowPw] = useState(false); // show/hide password
  const [authEmail, setAuthEmail] = useState(""); // email the 6-digit code was sent to
  const [codeMode, setCodeMode] = useState("signup"); // "signup" | "recovery"
  const [codeMsg, setCodeMsg] = useState("");
  const [forgotMsg, setForgotMsg] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0); // seconds until "Resend code" works again

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  /* ---------------- Auth: keep `user` and `role` in sync with Supabase ---------------- */
  useEffect(() => {
    const loadRole = async (u) => {
      if (!u) return setRole(null);
      const { data } = await supabase.from("profiles").select("role").eq("id", u.id).single();
      setRole(data?.role ?? "customer");
    };
    if (rememberExpired()) {
      // "Remember me" lasted 30 days: sign out so the user logs in again
      supabase.auth.signOut();
      setRemember(false);
    }
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setTimeout(() => loadRole(session?.user), 0); // setTimeout avoids a known Supabase deadlock
    });
    return () => sub.subscription.unsubscribe();
  }, []);
  const [toast, setToast] = useState({ show: false, text: "" });
  const toastTimer = useRef(null);

  const sectionRefs = {
    top: useRef(null),
    productsSection: useRef(null),
    storySection: useRef(null),
    blogSection: useRef(null),
  };

  /* ---------------- Toast ---------------- */
  const showToast = useCallback((text) => {
    setToast({ show: true, text });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast({ show: false, text }), 2200);
  }, []);

  /* ---------------- Cart ---------------- */
  const addToCart = (name, price) => {
    const existing = cart.find((i) => i.name === name);
    if (existing && existing.qty >= MAX_PER_ITEM) {
      showToast(`Limit of ${MAX_PER_ITEM} per fragrance`);
      return;
    }
    if (cartCount >= MAX_PER_ORDER) {
      showToast(`Limit of ${MAX_PER_ORDER} bottles per order`);
      return;
    }
    setCart((prev) => {
      const existing = prev.find((i) => i.name === name);
      if (existing) {
        return prev.map((i) => (i.name === name ? { ...i, qty: i.qty + 1 } : i));
      }
      return [...prev, { name, price, qty: 1 }];
    });
    showToast(`${name} added to your bag`);
  };

  const changeQty = (name, delta) => {
    if (delta > 0) {
      const item = cart.find((i) => i.name === name);
      if (item && item.qty >= MAX_PER_ITEM) {
        showToast(`Limit of ${MAX_PER_ITEM} per fragrance`);
        return;
      }
      if (cartCount >= MAX_PER_ORDER) {
        showToast(`Limit of ${MAX_PER_ORDER} bottles per order`);
        return;
      }
    }
    setCart((prev) =>
      prev
        .map((i) => (i.name === name ? { ...i, qty: i.qty + delta } : i))
        .filter((i) => i.qty > 0)
    );
  };

  const removeFromCart = (name) => {
    setCart((prev) => prev.filter((i) => i.name !== name));
  };

  const cartCount = cart.reduce((sum, i) => sum + i.qty, 0);
  const cartSubtotal = cart.reduce((sum, i) => sum + i.qty * i.price, 0);

  const handleCheckout = async (e) => {
    e.preventDefault();
    if (checkoutLoading) return;
    if (cart.length === 0) {
      showToast("Your bag is empty");
      return;
    }
    if (!user) {
      setCartOpen(false);
      openModal("signin");
      showToast("Please sign in to check out");
      return;
    }
    setCheckoutLoading(true);
    // Only names + quantities are sent; the database looks up the real prices.
    const { data, error } = await supabase.rpc("place_order", {
      p_items: cart.map((i) => ({ name: i.name, qty: i.qty })),
    });
    setCheckoutLoading(false);
    if (error) {
      showToast(error.message);
      return;
    }
    setCart([]);
    setCartOpen(false);
    showInfo(
      "Order confirmed",
      `Thank you! Your order ${data.order_no} has been placed. Total: $${data.total}.`
    );
  };

  /* ---------------- Modals ---------------- */
  const openModal = (id) => setOpenModalId(id);
  const closeModal = () => setOpenModalId(null);
  const switchModal = (toId) => setOpenModalId(toId);
  const showInfo = (title, body) => {
    setInfo({ title, body });
    setOpenModalId("info");
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        setOpenModalId(null);
        setCartOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /* ---------------- Sign in / create account / codes / forgot password / sign out ---------------- */
  const startCode = (email, mode) => {
    setAuthEmail(email);
    setCodeMode(mode);
    setCodeMsg("");
    setCooldown(60); // Supabase allows one new code per minute
    openModal("code");
  };

  const handleSignin = async (e) => {
    e.preventDefault();
    if (authBusy) return;
    const form = e.target;
    const fd = new FormData(form);
    const email = String(fd.get("email")).trim().toLowerCase();
    const password = String(fd.get("password"));
    if (!ALLOWED_EMAIL.test(email)) return setSigninMsg(EMAIL_RULE);
    if (!password) return setSigninMsg("Please enter your password.");

    setAuthBusy(true);
    setSigninMsg("Signing in…");
    setRemember(fd.get("remember") === "on"); // decides where the login is stored
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setAuthBusy(false);
    if (error) {
      if (/not confirmed/i.test(error.message)) {
        // account exists but the email was never verified: send a fresh code
        await supabase.auth.resend({ type: "signup", email });
        setSigninMsg("");
        return startCode(email, "signup");
      }
      return setSigninMsg(friendlyAuthError(error));
    }
    setSigninMsg("Signed in — welcome back.");
    setTimeout(() => {
      closeModal();
      setSigninMsg("");
      form.reset();
    }, 900);
  };

  const handleCreateAccount = async (e) => {
    e.preventDefault();
    if (authBusy) return;
    const fd = new FormData(e.target);
    const fullName = String(fd.get("full_name")).trim();
    const email = String(fd.get("email")).trim().toLowerCase();
    const password = String(fd.get("password"));
    if (fullName.length < 2) return setCreateMsg("Please enter your full name.");
    if (!ALLOWED_EMAIL.test(email)) return setCreateMsg(EMAIL_RULE);
    if (!validPassword(password)) return setCreateMsg(PASSWORD_RULE);

    setAuthBusy(true);
    setCreateMsg("Creating your account…");
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    });
    setAuthBusy(false);
    if (error) return setCreateMsg(friendlyAuthError(error));
    if (data.user && data.user.identities && data.user.identities.length === 0) {
      return setCreateMsg("That email is already registered. Try signing in.");
    }
    if (data.session) {
      // (only happens if "Confirm email" is switched off in Supabase)
      setCreateMsg("");
      closeModal();
      return showToast("Welcome to the house");
    }
    setCreateMsg("");
    startCode(email, "signup"); // a 6-digit code was emailed
  };

  const handleVerifyCode = async (e) => {
    e.preventDefault();
    if (authBusy) return;
    const fd = new FormData(e.target);
    const code = String(fd.get("code")).replace(/\D/g, "");
    const newPassword = String(fd.get("password") || "");
    if (code.length !== 6) return setCodeMsg("Enter the 6-digit code from your email.");
    if (codeMode === "recovery" && !validPassword(newPassword)) return setCodeMsg(PASSWORD_RULE);

    setAuthBusy(true);
    setCodeMsg("Checking your code…");
    setRemember(true); // verified users stay signed in for 30 days
    const { error } = await supabase.auth.verifyOtp({
      email: authEmail,
      token: code,
      type: codeMode === "recovery" ? "recovery" : "signup",
    });
    if (error) {
      setAuthBusy(false);
      return setCodeMsg("That code is incorrect or has expired. You can request a new one below.");
    }
    if (codeMode === "recovery") {
      const { error: pwError } = await supabase.auth.updateUser({ password: newPassword });
      if (pwError) {
        setAuthBusy(false);
        return setCodeMsg(friendlyAuthError(pwError));
      }
    }
    setAuthBusy(false);
    setCodeMsg("");
    closeModal();
    showToast(codeMode === "recovery" ? "Password updated — you're signed in" : "Email verified — welcome!");
  };

  const handleResend = async () => {
    if (cooldown > 0 || authBusy) return;
    setCodeMsg("Sending a new code…");
    const { error } =
      codeMode === "recovery"
        ? await supabase.auth.resetPasswordForEmail(authEmail)
        : await supabase.auth.resend({ type: "signup", email: authEmail });
    if (error) return setCodeMsg(friendlyAuthError(error));
    setCodeMsg("A new code is on its way.");
    setCooldown(60);
  };

  const handleForgot = async (e) => {
    e.preventDefault();
    if (authBusy) return;
    const email = String(new FormData(e.target).get("email")).trim().toLowerCase();
    if (!ALLOWED_EMAIL.test(email)) return setForgotMsg(EMAIL_RULE);
    setAuthBusy(true);
    setForgotMsg("Sending your code…");
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    setAuthBusy(false);
    if (error) return setForgotMsg(friendlyAuthError(error));
    setForgotMsg("");
    startCode(email, "recovery");
  };

  const handleSignout = () => openModal("signout"); // asks "Are you sure?" first
  const confirmSignout = async () => {
    setAuthBusy(true);
    await supabase.auth.signOut();
    setRemember(false);
    setAuthBusy(false);
    closeModal();
    showToast("Signed out");
  };

  /* ---------------- Order tracking: load the customer's latest orders when the popup opens ---------------- */
  const [trackingOrders, setTrackingOrders] = useState(null); // null = loading
  useEffect(() => {
    if (openModalId !== "tracking" || !user) return;
    setTrackingOrders(null);
    setTrackingMsg("");
    supabase
      .from("orders")
      .select("order_no, status, total, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(5)
      .then(({ data, error }) => {
        if (error) setTrackingMsg("We couldn't load your orders. Please try again.");
        setTrackingOrders(error ? [] : data);
      });
  }, [openModalId, user]);

  const handleNewsletter = async (e) => {
    e.preventDefault();
    setNewsletterLoading(true);
    setNewsletterError(false);
    setNewsletterMsg("");
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: newsletterEmail }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
      // success: text comes from the row Supabase actually saved
      setNewsletterMsg(
        data.already_subscribed
          ? `${data.email} is already on our list.`
          : `Thank you — ${data.email} has been added to our list.`
      );
      setNewsletterEmail("");
    } catch (err) {
      setNewsletterError(true);
      setNewsletterMsg(
        err instanceof TypeError
          ? "Network error — please check your connection and try again."
          : err.message
      );
    } finally {
      setNewsletterLoading(false);
    }
  };

  /* ---------------- Nav scroll ---------------- */
  const scrollToSection = (id) => {
    sectionRefs[id]?.current?.scrollIntoView({ behavior: "smooth" });
  };

  const crest = CrestDataUri();

  return (
    <div className="plp-root">
      <style>{`
        .plp-root{
          --ink:#121210; --panel:#1a1a17; --panel2:#201f1b;
          --gold:#c9a24b; --gold-soft:#d9be7f; --gold-line:rgba(201,162,75,0.35);
          --cream:#f3ede1; --cream-dim:#c9c3b4; --stone:#8f8a7c;
          background:var(--ink); color:var(--cream);
          font-family:'Jost',sans-serif; font-weight:300;
          -webkit-font-smoothing:antialiased;
        }
        .plp-root *{box-sizing:border-box;}
        .plp-root h1,.plp-root h2,.plp-root h3,.plp-root .serif{ font-family:'Cormorant Garamond', serif; font-weight:500; letter-spacing:0.01em; }
        .plp-root .eyebrow{
          font-family:'Jost',sans-serif; font-size:11px; letter-spacing:0.35em; text-transform:uppercase;
          color:var(--gold-soft); font-weight:400;
        }
        .plp-root a{color:inherit; text-decoration:none;}

        /* NAV */
        .plp-header{ position:sticky; top:0; z-index:50; background:rgba(18,18,16,0.92); backdrop-filter:blur(6px); border-bottom:1px solid var(--gold-line); }
        .plp-nav{ display:flex; align-items:center; justify-content:space-between; padding:18px 40px; max-width:1180px; margin:0 auto; }
        .plp-brand{display:flex; align-items:center; gap:12px;}
        .plp-brand img{height:40px; width:auto; display:block;}
        .plp-brand-name{font-family:'Cormorant Garamond',serif; font-size:20px; letter-spacing:0.12em; color:var(--cream);}
        .plp-brand-name span{display:block; font-family:'Jost',sans-serif; font-size:9px; letter-spacing:0.3em; color:var(--gold-soft); margin-top:2px;}
        .plp-nav-links{display:flex; gap:38px; font-size:13px; letter-spacing:0.08em; text-transform:uppercase;}
        .plp-nav-links a{color:var(--cream-dim); position:relative; padding-bottom:4px; transition:color .2s; cursor:pointer;}
        .plp-nav-links a:hover{color:var(--gold-soft);}
        .plp-nav-icons{display:flex; align-items:center; gap:22px; font-size:14px; color:var(--cream-dim);}
        .plp-nav-icons a{display:flex; align-items:center; gap:6px; cursor:pointer;}
        .plp-cart-count{
          background:var(--gold); color:#141310; font-size:10px; font-weight:500;
          width:16px; height:16px; border-radius:50%; display:flex; align-items:center; justify-content:center;
          font-family:'Jost',sans-serif;
        }

        /* HERO */
        .plp-hero{
          position:relative; overflow:hidden; padding:120px 40px 100px;
          background: radial-gradient(ellipse 700px 500px at 82% 18%, rgba(201,162,75,0.10), transparent 60%), linear-gradient(180deg,#141310,#0f0f0d);
          border-bottom:1px solid var(--gold-line);
        }
        .plp-hero-inner{max-width:1180px; margin:0 auto; display:grid; grid-template-columns:1.1fr 0.9fr; gap:60px; align-items:center;}
        .plp-hero-eyebrow{margin-bottom:22px;}
        .plp-hero h1{font-size:64px; line-height:1.05; color:var(--cream); margin:0 0 24px;}
        .plp-hero h1 em{font-style:italic; color:var(--gold-soft);}
        .plp-hero p{font-size:16px; line-height:1.8; color:var(--cream-dim); max-width:440px; margin:0 0 36px; font-weight:300;}
        .plp-btn-row{display:flex; gap:18px; align-items:center;}
        .plp-btn{
          display:inline-block; padding:15px 34px; font-size:12px; letter-spacing:0.18em; text-transform:uppercase;
          border:1px solid var(--gold); color:#141310; background:var(--gold); transition:all .25s; cursor:pointer;
        }
        .plp-btn:hover{background:transparent; color:var(--gold-soft);}
        .plp-btn-ghost{
          display:inline-block; padding:15px 30px; font-size:12px; letter-spacing:0.18em; text-transform:uppercase;
          border:1px solid var(--gold-line); color:var(--cream-dim); transition:all .25s; cursor:pointer; background:none;
        }
        .plp-btn-ghost:hover{border-color:var(--gold); color:var(--gold-soft);}
        .plp-hero-visual{ position:relative; display:flex; align-items:center; justify-content:center; height:460px; }
        .plp-hero-plate{
          width:380px; height:380px; border-radius:50%;
          background:radial-gradient(circle at 40% 30%, #23221d, #131210 72%);
          border:1px solid var(--gold-line); display:flex; align-items:center; justify-content:center; position:relative;
        }
        .plp-hero-plate::before{ content:""; position:absolute; inset:22px; border-radius:50%; border:1px solid rgba(201,162,75,0.18); }
        .plp-hero-plate svg{height:74%; width:auto; filter:drop-shadow(0 18px 30px rgba(0,0,0,0.55));}

        /* STRIP */
        .plp-strip{ border-bottom:1px solid var(--gold-line); padding:16px 40px; overflow:hidden; white-space:nowrap; background:var(--panel); }
        .plp-strip-track{display:inline-flex; gap:60px; font-size:11px; letter-spacing:0.28em; text-transform:uppercase; color:var(--stone);}
        /* scrolling ticker: 4 copies of the text, slides left by half (= 2 copies) and loops seamlessly */
        .plp-strip{-webkit-mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent); mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);}
        .plp-strip-track{padding-right:60px; animation:plp-marquee 40s linear infinite; will-change:transform;}
        .plp-strip:hover .plp-strip-track{animation-play-state:paused;}
        @keyframes plp-marquee{from{transform:translateX(0);} to{transform:translateX(-50%);}}
        @media (prefers-reduced-motion:reduce){.plp-strip-track{animation:none;}}

        /* SECTIONS */
        .plp-section{padding:100px 40px;}
        .plp-section-head{display:flex; align-items:flex-end; justify-content:space-between; margin-bottom:50px; border-bottom:1px solid var(--gold-line); padding-bottom:26px;}
        .plp-section-head h2{font-size:38px; color:var(--cream); margin:0;}
        .plp-section-head .plp-view-all{font-size:12px; letter-spacing:0.14em; text-transform:uppercase; color:var(--gold-soft); border-bottom:1px solid var(--gold-line); padding-bottom:4px; cursor:pointer;}

        /* GRID */
        .plp-grid{max-width:1180px; margin:0 auto; display:grid; grid-template-columns:repeat(4,1fr); gap:28px;}
        .plp-card{ background:var(--panel); border:1px solid var(--gold-line); display:flex; flex-direction:column; transition:border-color .25s, transform .25s; }
        .plp-card:hover{border-color:var(--gold); transform:translateY(-4px);}
        .plp-card-media{ height:220px; display:flex; align-items:center; justify-content:center; background:radial-gradient(ellipse at 50% 30%, #24221c, #17160f 75%); position:relative; border-bottom:1px solid var(--gold-line); }
        .plp-card-media svg{height:64%; width:auto;}
        .plp-card-badge{ position:absolute; top:12px; left:12px; font-size:9px; letter-spacing:0.2em; text-transform:uppercase; color:#141310; background:var(--gold-soft); padding:4px 9px; }
        .plp-card-body{padding:20px 20px 24px;}
        .plp-card-cat{font-size:10px; letter-spacing:0.2em; text-transform:uppercase; color:var(--stone); margin-bottom:8px;}
        .plp-card-name{font-family:'Cormorant Garamond',serif; font-size:21px; color:var(--cream); margin-bottom:6px;}
        .plp-card-note{font-size:12px; color:var(--cream-dim); margin-bottom:16px; line-height:1.6;}
        .plp-card-foot{display:flex; align-items:center; justify-content:space-between;}
        .plp-price{font-family:'Cormorant Garamond',serif; font-size:19px; color:var(--gold-soft);}
        .plp-add{
          font-size:10px; letter-spacing:0.14em; text-transform:uppercase; color:var(--cream);
          border:1px solid var(--gold-line); padding:8px 14px; transition:all .2s; cursor:pointer; background:none;
          font-family:'Jost',sans-serif;
        }
        .plp-add:hover{border-color:var(--gold); color:var(--gold-soft);}

        /* SPLIT */
        .plp-split{ background:var(--panel2); border-top:1px solid var(--gold-line); border-bottom:1px solid var(--gold-line); }
        .plp-split-inner{max-width:1180px; margin:0 auto; display:grid; grid-template-columns:1fr 1fr;}
        .plp-split-media{ min-height:420px; display:flex; align-items:center; justify-content:center; background:radial-gradient(ellipse at 50% 40%, #26241d, #16150f 75%); border-right:1px solid var(--gold-line); }
        .plp-split-media img{height:52%; width:auto;}
        .plp-split-text{padding:80px 60px; display:flex; flex-direction:column; justify-content:center;}
        .plp-split-text h2{font-size:34px; margin:16px 0 20px; color:var(--cream);}
        .plp-split-text p{font-size:15px; line-height:1.85; color:var(--cream-dim); margin:0 0 28px; max-width:420px; font-weight:300;}

        /* BLOG */
        .plp-blog-grid{max-width:1180px; margin:0 auto; display:grid; grid-template-columns:repeat(3,1fr); gap:28px;}
        .plp-post{border:1px solid var(--gold-line); cursor:pointer; transition:border-color .2s;}
        .plp-post:hover{border-color:var(--gold);}
        .plp-post-media{height:170px; background:linear-gradient(150deg,#221f18,#151410);}
        .plp-post-body{padding:22px;}
        .plp-post-tag{font-size:10px; letter-spacing:0.2em; text-transform:uppercase; color:var(--gold-soft); margin-bottom:10px;}
        .plp-post h3{font-size:20px; color:var(--cream); margin:0 0 10px; line-height:1.3;}
        .plp-post p{font-size:12.5px; color:var(--cream-dim); line-height:1.7; margin:0;}

        /* NEWSLETTER */
        .plp-news{
          padding:90px 40px; text-align:center; border-bottom:1px solid var(--gold-line);
          background:radial-gradient(ellipse 800px 300px at 50% 0%, rgba(201,162,75,0.08), transparent 70%);
        }
        .plp-news h2{font-size:34px; margin:16px 0 14px;}
        .plp-news p{color:var(--cream-dim); font-size:14px; margin:0 0 30px;}
        .plp-news-form{display:flex; justify-content:center; gap:0; max-width:440px; margin:0 auto;}
        .plp-news-form input{
          flex:1; background:transparent; border:1px solid var(--gold-line); border-right:none;
          padding:15px 18px; color:var(--cream); font-family:'Jost',sans-serif; font-size:13px; outline:none;
        }
        .plp-news-form input::placeholder{color:var(--stone);}
        .plp-news-form button{
          background:var(--gold); border:1px solid var(--gold); color:#141310; padding:0 26px;
          font-size:12px; letter-spacing:0.14em; text-transform:uppercase; cursor:pointer;
        }
        .plp-news-msg{margin-top:16px; font-size:13px; color:var(--gold-soft);}
        .plp-news-form button:disabled{opacity:.6; cursor:wait;}

        /* FOOTER */
        .plp-footer{padding:70px 40px 30px; background:#0d0d0b;}
        .plp-foot-inner{max-width:1180px; margin:0 auto; display:grid; grid-template-columns:1.4fr 1fr 1fr 1fr; gap:40px; padding-bottom:50px; border-bottom:1px solid var(--gold-line);}
        .plp-foot-brand img{height:36px; margin-bottom:16px;}
        .plp-foot-brand p{font-size:12.5px; color:var(--stone); line-height:1.8; max-width:260px; margin:0;}
        .plp-foot-col h4{font-size:11px; letter-spacing:0.2em; text-transform:uppercase; color:var(--gold-soft); margin:0 0 18px; font-weight:400; font-family:'Jost',sans-serif;}
        .plp-foot-col a{display:block; font-size:13px; color:var(--cream-dim); margin-bottom:12px; cursor:pointer;}
        .plp-foot-col a:hover{color:var(--gold-soft);}
        .plp-foot-bottom{max-width:1180px; margin:0 auto; display:flex; justify-content:space-between; align-items:center; padding-top:24px; font-size:11px; color:var(--stone); letter-spacing:0.04em;}

        @media (max-width:980px){
          .plp-hero-inner{grid-template-columns:1fr;}
          .plp-hero-visual{height:300px;}
          .plp-grid{grid-template-columns:repeat(2,1fr);}
          .plp-split-inner{grid-template-columns:1fr;}
          .plp-split-media{border-right:none; border-bottom:1px solid var(--gold-line); min-height:260px;}
          .plp-blog-grid{grid-template-columns:1fr;}
          .plp-foot-inner{grid-template-columns:1fr 1fr;}
          .plp-nav-links{display:none;}
        }

        /* MOBILE (phones and small tablets). Desktop layout is unchanged. */
        .plp-root{-webkit-tap-highlight-color:transparent;}
        .plp-root a,.plp-root button{touch-action:manipulation;}
        .plp-header{padding-top:env(safe-area-inset-top, 0px);}
        .plp-footer{padding-bottom:calc(30px + env(safe-area-inset-bottom, 0px));}
        .plp-cart-foot{padding-bottom:calc(22px + env(safe-area-inset-bottom, 0px));}

        /* menu button (phones and tablets only) */
        .plp-menu-btn{display:none; background:none; border:none; cursor:pointer; padding:12px 6px; margin-right:-6px;}
        .plp-menu-btn span{display:block; width:22px; height:1.5px; background:var(--cream); margin:5px 0; transition:transform .25s, opacity .25s;}
        .plp-menu-btn.open span:nth-child(1){transform:translateY(6.5px) rotate(45deg);}
        .plp-menu-btn.open span:nth-child(2){opacity:0;}
        .plp-menu-btn.open span:nth-child(3){transform:translateY(-6.5px) rotate(-45deg);}
        @media (max-width:980px){
          .plp-nav{flex-wrap:wrap;}
          .plp-menu-btn{display:block;}
          .plp-nav-links{
            display:none; order:3; width:100%; flex-direction:column; gap:0; margin-top:10px;
            border-top:1px solid var(--gold-line); font-size:13px;
          }
          .plp-nav-links.open{display:flex;}
          .plp-nav-links a{padding:15px 2px; border-bottom:1px solid rgba(201,162,75,0.15);}
        }

        @media (max-width:600px){
          .plp-root{overflow-x:clip;}
          .plp-nav{padding:12px 16px;}
          .plp-brand img{height:32px;}
          .plp-brand-name{font-size:16px;}
          .plp-nav-icons{gap:14px; font-size:13px;}
          .plp-nav-icons a{padding:6px 0;}

          .plp-hero{padding:52px 20px 56px;}
          .plp-hero h1{font-size:40px;}
          .plp-hero p{font-size:15px; margin-bottom:28px;}
          .plp-hero-visual{height:260px;}
          .plp-hero-plate{width:250px; height:250px;}
          .plp-btn-row{flex-direction:column; align-items:stretch; gap:12px; text-align:center;}
          .plp-btn-row a{width:auto;}
          .plp-strip{padding:14px 20px;}

          .plp-section{padding:56px 20px;}
          .plp-section-head{flex-direction:column; align-items:flex-start; gap:14px; margin-bottom:30px;}
          .plp-section-head h2{font-size:30px;}
          .plp-grid{grid-template-columns:1fr; gap:20px;}
          .plp-card-media{height:200px;}
          .plp-split-text{padding:44px 24px;}
          .plp-split-text h2{font-size:28px;}
          .plp-news{padding:56px 20px;}
          .plp-news h2{font-size:28px;}
          .plp-news-form input{font-size:16px;}
          .plp-footer{padding-top:48px; padding-left:20px; padding-right:20px;}
          .plp-foot-inner{grid-template-columns:1fr; gap:28px;}
          .plp-foot-bottom{flex-direction:column; gap:10px; text-align:center;}

          /* popups, bag and toast */
          .plp-modal{padding:30px 20px; max-height:88dvh;}
          .plp-modal-close{top:8px; right:8px; width:44px; height:44px; font-size:26px;}
          .plp-field input{font-size:16px; padding:14px;}  /* 16px stops iPhones zooming in on focus */
          .plp-cart-drawer{height:100dvh;}
          .plp-cart-head{padding:18px 20px;}
          .plp-cart-items{padding:8px 20px;}
          .plp-cart-foot{padding-left:20px; padding-right:20px;}
          .plp-qty-btn{width:34px; height:34px; font-size:16px;}
          .plp-toast{max-width:calc(100% - 32px); text-align:center; padding:12px 18px; bottom:calc(20px + env(safe-area-inset-bottom, 0px));}
        }

        /* MODALS */
        .plp-overlay{
          position:fixed; inset:0; background:rgba(10,10,9,0.72); backdrop-filter:blur(3px);
          display:flex; align-items:center; justify-content:center; z-index:200; padding:20px;
        }
        .plp-modal{
          background:var(--panel); border:1px solid var(--gold-line); max-width:420px; width:100%;
          padding:36px 32px; position:relative; max-height:88vh; overflow-y:auto;
        }
        .plp-modal-close{
          position:absolute; top:16px; right:18px; font-size:20px; color:var(--cream-dim); cursor:pointer;
          line-height:1; background:none; border:none;
        }
        .plp-modal-close:hover{color:var(--gold-soft);}
        .plp-modal h3{font-family:'Cormorant Garamond',serif; font-size:26px; color:var(--cream); margin:0 0 6px;}
        .plp-modal .plp-sub{font-size:12.5px; color:var(--stone); margin-bottom:24px;}
        .plp-field{margin-bottom:16px;}
        .plp-field label{display:block; font-size:11px; letter-spacing:0.1em; text-transform:uppercase; color:var(--cream-dim); margin-bottom:8px;}
        .plp-field input{
          width:100%; background:transparent; border:1px solid var(--gold-line); padding:12px 14px;
          color:var(--cream); font-family:'Jost',sans-serif; font-size:13px; outline:none;
        }
        .plp-field input:focus{border-color:var(--gold);}
        .plp-modal{overflow-y:auto;}
        .plp-pw{position:relative;}
        .plp-field .plp-pw input{padding-right:70px;}
        .plp-pw-toggle{position:absolute; right:6px; top:50%; transform:translateY(-50%); background:none; border:none; color:var(--gold-soft);
          font-family:'Jost',sans-serif; font-size:11px; letter-spacing:0.14em; text-transform:uppercase; cursor:pointer; padding:10px;}
        .plp-row{display:flex; justify-content:space-between; align-items:center; gap:10px 16px; flex-wrap:wrap; margin:2px 0 18px; font-size:12px;}
        .plp-row a{color:var(--gold-soft); cursor:pointer;}
        .plp-check{display:flex; align-items:center; gap:8px; color:var(--cream-dim); cursor:pointer;}
        .plp-check input{width:auto; accent-color:var(--gold);}
        .plp-hint{font-size:12px; color:var(--stone); margin:-6px 0 18px;}
        .plp-field input.plp-code{text-align:center; letter-spacing:0.5em; font-size:22px;}
        .plp-btn:disabled{opacity:.6; cursor:wait;}
        .plp-modal-msg{font-size:12.5px; color:var(--gold-soft); margin-top:14px;}
        .plp-switch-line{font-size:12px; color:var(--stone); margin-top:18px; text-align:center;}
        .plp-switch-line a{color:var(--gold-soft); cursor:pointer;}

        /* CART DRAWER */
        .plp-cart-drawer{
          position:fixed; top:0; right:0; height:100%; width:100%; max-width:400px;
          background:var(--panel); border-left:1px solid var(--gold-line); z-index:210;
          transform:translateX(100%); transition:transform .3s ease; display:flex; flex-direction:column;
        }
        .plp-cart-drawer.open{transform:translateX(0);}
        .plp-cart-head{padding:24px; border-bottom:1px solid var(--gold-line); display:flex; justify-content:space-between; align-items:center;}
        .plp-cart-head h3{font-family:'Cormorant Garamond',serif; font-size:22px; margin:0;}
        .plp-cart-items{flex:1; overflow-y:auto; padding:16px 24px;}
        .plp-cart-item{display:flex; gap:14px; padding:16px 0; border-bottom:1px solid rgba(201,162,75,0.15);}
        .plp-cart-item-thumb{width:52px; height:70px; background:radial-gradient(ellipse at 50% 30%, #24221c, #17160f 75%); border:1px solid var(--gold-line); flex-shrink:0;}
        .plp-cart-item-info{flex:1;}
        .plp-cart-item-info .plp-name{font-family:'Cormorant Garamond',serif; font-size:16px; color:var(--cream);}
        .plp-cart-item-info .plp-meta{font-size:11px; color:var(--stone); margin:4px 0 8px;}
        .plp-qty-row{display:flex; align-items:center; gap:10px; font-size:12px;}
        .plp-qty-btn{border:1px solid var(--gold-line); width:22px; height:22px; display:flex; align-items:center; justify-content:center; cursor:pointer; background:none; color:var(--cream);}
        .plp-qty-btn:hover{border-color:var(--gold); color:var(--gold-soft);}
        .plp-remove-link{font-size:11px; color:var(--stone); text-decoration:underline; cursor:pointer; margin-left:auto;}
        .plp-remove-link:hover{color:var(--gold-soft);}
        .plp-cart-empty{padding:60px 20px; text-align:center; color:var(--stone); font-size:13px;}
        .plp-cart-foot{padding:22px 24px; border-top:1px solid var(--gold-line);}
        .plp-cart-subtotal{display:flex; justify-content:space-between; font-size:14px; margin-bottom:16px; color:var(--cream);}
        .plp-toast{
          position:fixed; bottom:28px; left:50%; transform:translateX(-50%) translateY(20px);
          background:var(--gold); color:#141310; padding:13px 26px; font-size:12.5px; letter-spacing:0.04em;
          z-index:300; opacity:0; pointer-events:none; transition:all .3s ease;
        }
        .plp-toast.show{opacity:1; transform:translateX(-50%) translateY(0); pointer-events:auto;}
      `}</style>

      {/* ---------- Modals ---------- */}
      {openModalId === "signin" && (
        <div className="plp-overlay" onClick={(e) => e.target === e.currentTarget && closeModal()}>
          <div className="plp-modal">
            <button className="plp-modal-close" onClick={closeModal}>&times;</button>
            <h3>Sign in</h3>
            <div className="plp-sub">Access your account, orders and wishlist.</div>
            <form onSubmit={handleSignin} noValidate>
              <div className="plp-field">
                <label>Email</label>
                <input name="email" type="email" required placeholder="name@gmail.com" autoComplete="email" />
              </div>
              <div className="plp-field">
                <label>Password</label>
                <div className="plp-pw">
                  <input name="password" type={showPw ? "text" : "password"} required placeholder="••••••••" autoComplete="current-password" />
                  <button type="button" className="plp-pw-toggle" onClick={() => setShowPw((v) => !v)}>
                    {showPw ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
              <div className="plp-row">
                <label className="plp-check">
                  <input type="checkbox" name="remember" defaultChecked /> Remember me for 30 days
                </label>
                <a onClick={() => switchModal("forgot")}>Forgot password?</a>
              </div>
              <button type="submit" className="plp-btn" style={{ width: "100%" }} disabled={authBusy}>Sign in</button>
              {signinMsg && <div className="plp-modal-msg">{signinMsg}</div>}
            </form>
            <div className="plp-switch-line">
              New here? <a onClick={() => switchModal("create")}>Create an account</a>
            </div>
          </div>
        </div>
      )}

      {openModalId === "create" && (
        <div className="plp-overlay" onClick={(e) => e.target === e.currentTarget && closeModal()}>
          <div className="plp-modal">
            <button className="plp-modal-close" onClick={closeModal}>&times;</button>
            <h3>Create account</h3>
            <div className="plp-sub">Use your @gmail.com or @tip.edu.ph email. We'll send you a 6-digit code to verify it.</div>
            <form onSubmit={handleCreateAccount} noValidate>
              <div className="plp-field">
                <label>Full name</label>
                <input name="full_name" type="text" required placeholder="Jane Doe" autoComplete="name" />
              </div>
              <div className="plp-field">
                <label>Email</label>
                <input name="email" type="email" required placeholder="name@gmail.com" autoComplete="email" />
              </div>
              <div className="plp-field">
                <label>Password</label>
                <div className="plp-pw">
                  <input name="password" type={showPw ? "text" : "password"} required placeholder="••••••••" autoComplete="new-password" />
                  <button type="button" className="plp-pw-toggle" onClick={() => setShowPw((v) => !v)}>
                    {showPw ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
              <div className="plp-hint">8+ characters, with at least one letter and one number.</div>
              <button type="submit" className="plp-btn" style={{ width: "100%" }} disabled={authBusy}>Create account</button>
              {createMsg && <div className="plp-modal-msg">{createMsg}</div>}
            </form>
            <div className="plp-switch-line">
              Already a member? <a onClick={() => switchModal("signin")}>Sign in</a>
            </div>
          </div>
        </div>
      )}

      {openModalId === "forgot" && (
        <div className="plp-overlay" onClick={(e) => e.target === e.currentTarget && closeModal()}>
          <div className="plp-modal">
            <button className="plp-modal-close" onClick={closeModal}>&times;</button>
            <h3>Forgot password</h3>
            <div className="plp-sub">Enter your email and we'll send you a 6-digit code.</div>
            <form onSubmit={handleForgot} noValidate>
              <div className="plp-field">
                <label>Email</label>
                <input name="email" type="email" required placeholder="name@gmail.com" autoComplete="email" autoFocus />
              </div>
              <button type="submit" className="plp-btn" style={{ width: "100%" }} disabled={authBusy}>Send code</button>
              {forgotMsg && <div className="plp-modal-msg">{forgotMsg}</div>}
            </form>
            <div className="plp-switch-line">
              Remembered it? <a onClick={() => switchModal("signin")}>Sign in</a>
            </div>
          </div>
        </div>
      )}

      {openModalId === "code" && (
        <div className="plp-overlay" onClick={(e) => e.target === e.currentTarget && closeModal()}>
          <div className="plp-modal">
            <button className="plp-modal-close" onClick={closeModal}>&times;</button>
            <h3>{codeMode === "recovery" ? "Reset your password" : "Verify your email"}</h3>
            <div className="plp-sub">
              We sent a 6-digit code to {authEmail}. It expires in 1 hour. Check your spam folder too.
            </div>
            <form onSubmit={handleVerifyCode} noValidate>
              <div className="plp-field">
                <label>6-digit code</label>
                <input
                  name="code"
                  className="plp-code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  autoComplete="one-time-code"
                  placeholder="000000"
                  autoFocus
                />
              </div>
              {codeMode === "recovery" && (
                <div className="plp-field">
                  <label>New password</label>
                  <div className="plp-pw">
                  <input name="password" type={showPw ? "text" : "password"} required placeholder="••••••••" autoComplete="new-password" />
                  <button type="button" className="plp-pw-toggle" onClick={() => setShowPw((v) => !v)}>
                    {showPw ? "Hide" : "Show"}
                  </button>
                </div>
                </div>
              )}
              <button type="submit" className="plp-btn" style={{ width: "100%" }} disabled={authBusy}>
                {codeMode === "recovery" ? "Reset password" : "Verify and continue"}
              </button>
              {codeMsg && <div className="plp-modal-msg">{codeMsg}</div>}
            </form>
            <div className="plp-switch-line">
              Didn't get it? {cooldown > 0 ? <span>Resend in {cooldown}s</span> : <a onClick={handleResend}>Resend code</a>}
            </div>
          </div>
        </div>
      )}

      {openModalId === "signout" && (
        <div className="plp-overlay" onClick={(e) => e.target === e.currentTarget && closeModal()}>
          <div className="plp-modal">
            <button className="plp-modal-close" onClick={closeModal}>&times;</button>
            <h3>Sign out?</h3>
            <div className="plp-sub">You'll need to sign in again to place or track orders.</div>
            <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
              <button
                className="plp-btn"
                style={{ flex: 1, background: "transparent", border: "1px solid var(--gold-line)", color: "var(--cream)" }}
                onClick={closeModal}
              >
                Stay signed in
              </button>
              <button className="plp-btn" style={{ flex: 1 }} onClick={confirmSignout} disabled={authBusy}>
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}

      {openModalId === "tracking" && (
        <div className="plp-overlay" onClick={(e) => e.target === e.currentTarget && closeModal()}>
          <div className="plp-modal">
            <button className="plp-modal-close" onClick={closeModal}>&times;</button>
            <h3>Track your order</h3>
            <div className="plp-sub">Your five most recent orders and their status.</div>
            {!user ? (
              <>
                <div className="plp-modal-msg">Please sign in to see your orders.</div>
                <button className="plp-btn" style={{ width: "100%", marginTop: 16 }} onClick={() => openModal("signin")}>
                  Sign in
                </button>
              </>
            ) : trackingOrders === null ? (
              <div className="plp-modal-msg">Loading…</div>
            ) : trackingOrders.length === 0 ? (
              <div className="plp-modal-msg">{trackingMsg || "You haven't placed an order yet."}</div>
            ) : (
              trackingOrders.map((o) => (
                <div className="plp-modal-msg" key={o.order_no}>
                  <strong>{o.order_no}</strong> — {STATUS_LABEL[o.status] || o.status} · {new Date(o.created_at).toLocaleDateString()} · ${o.total}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {openModalId === "info" && (
        <div className="plp-overlay" onClick={(e) => e.target === e.currentTarget && closeModal()}>
          <div className="plp-modal">
            <button className="plp-modal-close" onClick={closeModal}>&times;</button>
            <h3>{info.title}</h3>
            <div className="plp-sub">{info.body}</div>
          </div>
        </div>
      )}

      {/* ---------- Cart Drawer ---------- */}
      <div className={`plp-cart-drawer${cartOpen ? " open" : ""}`}>
        <div className="plp-cart-head">
          <h3>Your bag</h3>
          <button className="plp-modal-close" style={{ position: "static" }} onClick={() => setCartOpen(false)}>&times;</button>
        </div>
        <div className="plp-cart-items">
          {cart.length === 0 ? (
            <div className="plp-cart-empty">Your bag is empty.</div>
          ) : (
            cart.map((item) => (
              <div className="plp-cart-item" key={item.name}>
                <div className="plp-cart-item-thumb" />
                <div className="plp-cart-item-info">
                  <div className="plp-name">{item.name}</div>
                  <div className="plp-meta">${item.price} each</div>
                  <div className="plp-qty-row">
                    <button className="plp-qty-btn" onClick={() => changeQty(item.name, -1)}>-</button>
                    <span>{item.qty}</span>
                    <button className="plp-qty-btn" onClick={() => changeQty(item.name, 1)}>+</button>
                    <span className="plp-remove-link" onClick={() => removeFromCart(item.name)}>Remove</span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="plp-cart-foot">
          <div className="plp-cart-subtotal">
            <span>Subtotal</span>
            <span>${cartSubtotal}</span>
          </div>
          <a href="#" className="plp-btn" style={{ width: "100%", textAlign: "center", display: "block" }} onClick={handleCheckout}>
            {checkoutLoading ? "Placing order…" : "Checkout"}
          </a>
        </div>
      </div>

      <div className={`plp-toast${toast.show ? " show" : ""}`}>{toast.text}</div>

      {/* ---------- Header ---------- */}
      <header className="plp-header">
        <nav className="plp-nav">
          <div className="plp-brand">
            <img src={crest} alt="Prestige Le Parfum" />
            <div className="plp-brand-name">PRESTIGE<span>LE PARFUM</span></div>
          </div>
          <div className={"plp-nav-links" + (menuOpen ? " open" : "")} onClick={() => setMenuOpen(false)}>
            <a onClick={() => scrollToSection("top")}>Home</a>
            <a onClick={() => scrollToSection("productsSection")}>Products</a>
            <a onClick={() => scrollToSection("storySection")}>Collections</a>
            <a onClick={() => scrollToSection("blogSection")}>Blog</a>
            <a onClick={() => openModal("tracking")}>Order Tracking</a>
          </div>
          <div className="plp-nav-icons">
            {user ? (
              <>
                {role === "admin" && <a href="/admin">Admin</a>}
                <a onClick={handleSignout}>Sign out</a>
              </>
            ) : (
              <a onClick={() => openModal("signin")}>Sign in</a>
            )}
            <a onClick={() => setCartOpen(true)}>Bag <span className="plp-cart-count">{cartCount}</span></a>
            <button
              className={"plp-menu-btn" + (menuOpen ? " open" : "")}
              aria-label="Menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <span /><span /><span />
            </button>
          </div>
        </nav>
      </header>

      {/* ---------- Hero ---------- */}
      <section className="plp-hero" ref={sectionRefs.top}>
        <div className="plp-hero-inner">
          <div>
            <div className="eyebrow plp-hero-eyebrow">New Season Collection</div>
            <h1>Wear a scent<br />worthy of <em>a crown</em></h1>
            <p>Rare ingredients, hand-finished bottles, and fragrances composed for those who don't follow trends. Discover the house of Prestige Le Parfum.</p>
            <div className="plp-btn-row">
              <a className="plp-btn" onClick={() => scrollToSection("productsSection")}>Shop the collection</a>
              <a className="plp-btn-ghost" onClick={() => scrollToSection("storySection")}>Our story</a>
            </div>
          </div>
          <div className="plp-hero-visual">
            <div className="plp-hero-plate">
              <BottleSVG />
            </div>
          </div>
        </div>
      </section>

      {/* ---------- Strip ---------- */}
      <div className="plp-strip">
        <div className="plp-strip-track">
          {[...STRIP_ITEMS, ...STRIP_ITEMS, ...STRIP_ITEMS, ...STRIP_ITEMS].map((t, i) => (
            <span key={i}>{t}</span>
          ))}
        </div>
      </div>

      {/* ---------- Products ---------- */}
      <section className="plp-section" ref={sectionRefs.productsSection}>
        <div className="plp-section-head">
          <div>
            <div className="eyebrow">Best sellers</div>
            <h2>Signature edition</h2>
          </div>
          <a
            className="plp-view-all"
            onClick={() =>
              showInfo("Coming soon", "The full collection is on its way. Check back soon.")
            }
          >
            View all products
          </a>
        </div>

        <div className="plp-grid">
          {PRODUCTS.map((p) => (
            <div className="plp-card" key={p.name}>
              <div className="plp-card-media">
                {p.badge && <span className="plp-card-badge">{p.badge}</span>}
                <BottleSVG />
              </div>
              <div className="plp-card-body">
                <div className="plp-card-cat">Eau de Parfum · 50ml</div>
                <div className="plp-card-name">{p.name}</div>
                <div className="plp-card-note">{p.notes}</div>
                <div className="plp-card-foot">
                  <span className="plp-price">${p.price}</span>
                  <button className="plp-add" onClick={() => addToCart(p.name, p.price)}>Add to bag</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- Story split ---------- */}
      <section className="plp-split" ref={sectionRefs.storySection}>
        <div className="plp-split-inner">
          <div className="plp-split-media">
            <img src={crest} alt="Prestige Le Parfum crest" />
          </div>
          <div className="plp-split-text">
            <div className="eyebrow">The house</div>
            <h2>Composed in small<br />batches, worn for years</h2>
            <p>Every Prestige Le Parfum fragrance is blended in limited runs and finished by hand, so each bottle that reaches your door carries the same care it left the atelier with.</p>
            <a
              className="plp-btn-ghost"
              style={{ width: "fit-content" }}
              onClick={() =>
                showInfo("Coming soon", "Our full story is on its way. Check back soon.")
              }
            >
              Discover our story
            </a>
          </div>
        </div>
      </section>

      {/* ---------- Blog ---------- */}
      <section className="plp-section" ref={sectionRefs.blogSection}>
        <div className="plp-section-head">
          <div>
            <div className="eyebrow">Journal</div>
            <h2>From the blog</h2>
          </div>
          <a
            className="plp-view-all"
            onClick={() => showInfo("Coming soon", "The journal is on its way. Check back soon.")}
          >
            Read the journal
          </a>
        </div>
        <div className="plp-blog-grid">
          {BLOG_POSTS.map((post) => (
            <div className="plp-post" key={post.title} onClick={() => showInfo(post.infoTitle, post.infoBody)}>
              <div className="plp-post-media" />
              <div className="plp-post-body">
                <div className="plp-post-tag">{post.tag}</div>
                <h3>{post.title}</h3>
                <p>{post.excerpt}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- Newsletter ---------- */}
      <section className="plp-news">
        <div className="eyebrow">Stay in the house</div>
        <h2>Join our mailing list</h2>
        <p>New arrivals, private previews, and notes from the atelier — no more than twice a month.</p>
        <form className="plp-news-form" onSubmit={handleNewsletter}>
          <input
            type="email"
            placeholder="name@email.com"
            required
            value={newsletterEmail}
            onChange={(e) => setNewsletterEmail(e.target.value)}
          />
          <button type="submit" disabled={newsletterLoading}>
            {newsletterLoading ? "Subscribing…" : "Subscribe"}
          </button>
        </form>
        {newsletterMsg && (
          <div className="plp-news-msg" style={newsletterError ? { color: "#e0907f" } : undefined}>
            {newsletterMsg}
          </div>
        )}
      </section>

      {/* ---------- Footer ---------- */}
      <footer className="plp-footer">
        <div className="plp-foot-inner">
          <div className="plp-foot-brand">
            <img src={crest} alt="Prestige Le Parfum" />
            <p>A house of fragrance built on rare materials, small batches, and unmistakable presence.</p>
          </div>
          <div className="plp-foot-col">
            <h4>Shop</h4>
            <a onClick={() => scrollToSection("productsSection")}>All products</a>
            <a onClick={() => scrollToSection("productsSection")}>Best sellers</a>
            <a onClick={() => showInfo("Coming soon", "New arrivals will appear here as they launch.")}>New arrivals</a>
            <a onClick={() => showInfo("Coming soon", "Gift sets are being curated. Check back soon.")}>Gift sets</a>
          </div>
          <div className="plp-foot-col">
            <h4>Support</h4>
            <a onClick={() => openModal("tracking")}>Order tracking</a>
            <a onClick={() => showInfo("Shipping and returns", "Free shipping on orders over $120. Returns are accepted within 30 days of delivery in original condition.")}>Shipping and returns</a>
            <a onClick={() => showInfo("Contact us", "Reach us any time at hello@prestigeleparfum.example — we usually reply within one business day.")}>Contact us</a>
            <a onClick={() => showInfo("Coming soon", "Our FAQ is being compiled. Check back soon.")}>FAQ</a>
          </div>
          <div className="plp-foot-col">
            <h4>Account</h4>
            <a onClick={() => openModal("signin")}>Sign in</a>
            <a onClick={() => openModal("create")}>Create account</a>
            <a onClick={() => openModal("tracking")}>My orders</a>
            <a onClick={() => showInfo("Wishlist", "Sign in to view and manage your wishlist.")}>Wishlist</a>
          </div>
        </div>
        <div className="plp-foot-bottom">
          <span>&copy; 2026 Prestige Le Parfum. All rights reserved.</span>
        </div>
      </footer>
    </div>
  );
}