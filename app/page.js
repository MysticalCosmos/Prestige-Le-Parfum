"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { supabase, setRemember, rememberExpired } from "../lib/supabase";
import { useRouter } from "next/navigation";

// true  = visitors see the login screen first (website and APK)
// false = anyone can browse the store without signing in
const REQUIRE_LOGIN = true;

const MAX_PER_ITEM = 5; // bottles of the same fragrance per order
const MAX_PER_ORDER = 10; // bottles in total per order
const STATUS_LABEL = { pending: "Order Received", paid: "Paid", shipped: "Shipped", delivered: "Delivered", cancelled: "Cancelled" };

/* ---------------- Account rules ---------------- */
// Only these email providers can sign up. Typos and unknown domains are rejected.
// Keep this list identical to the one in supabase/email-domains.sql.
const ALLOWED_DOMAINS = [
  "gmail.com", "yahoo.com", "yahoo.com.ph", "outlook.com", "outlook.ph", "hotmail.com",
  "live.com", "icloud.com", "proton.me", "protonmail.com", "tip.edu.ph",
];
const ALLOWED_EMAIL = new RegExp("^[^\\s@]+@(" + ALLOWED_DOMAINS.map((d) => d.replace(/\./g, "\\.")).join("|") + ")$", "i");

// "Did you mean ...?" for near-misses such as gmial.com, gmail.con or tip.edu.pg
const editDistance = (a, b) => {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
};
const suggestEmail = (email) => {
  const at = email.lastIndexOf("@");
  if (at < 1) return "";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  let best = "";
  let bestDistance = 99;
  for (const d of ALLOWED_DOMAINS) {
    const dist = editDistance(domain, d);
    const limit = d.length >= 8 ? 2 : 1; // short domains must be very close, to avoid wrong guesses
    if (dist > 0 && dist <= limit && dist < bestDistance) {
      best = d;
      bestDistance = dist;
    }
  }
  return best ? local + "@" + best : "";
};
const EMAIL_RULE = "Please use a valid email from Gmail, Outlook, Yahoo, iCloud, Proton or @tip.edu.ph.";
const PASSWORD_RULE = "Password needs 8+ characters with at least one letter and one number.";
const validPassword = (p) => p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p);

/* ---------------- Fields that give feedback while you type ---------------- */
function EmailField({ defaultValue = "", autoFocus = false }) {
  const [value, setValue] = useState(defaultValue);
  const [touched, setTouched] = useState(false); // becomes true when you leave the field
  const v = value.trim();
  const ok = ALLOWED_EMAIL.test(v);
  let msg = "";
  let kind = "";
  if (ok) { msg = "Email looks good."; kind = "ok"; }
  else if (touched && v === "") { msg = "Please enter your email."; kind = "bad"; }
  else if (touched) { msg = EMAIL_RULE; kind = "bad"; }
  else if (v.includes("@")) { msg = "Use a supported email (Gmail, Outlook, Yahoo, iCloud, Proton or @tip.edu.ph)."; kind = "hint"; }
  const suggestion = kind === "bad" ? suggestEmail(v) : "";
  return (
    <div className="plp-field">
      <label>Email</label>
      <input
        name="email"
        type="email"
        required
        placeholder="name@gmail.com"
        autoComplete="email"
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => setTouched(true)}
        className={kind === "bad" ? "plp-invalid" : kind === "ok" ? "plp-valid" : ""}
        aria-invalid={kind === "bad"}
      />
      {suggestion ? (
        <div className="plp-fieldmsg bad">
          Did you mean <a onClick={() => setValue(suggestion)}>{suggestion}</a>?
        </div>
      ) : (
        msg && <div className={"plp-fieldmsg " + kind}>{msg}</div>
      )}
    </div>
  );
}

function PasswordField({ label = "Password", autoComplete, autoFocus = false, showPw, onToggle, showRules = false }) {
  const [value, setValue] = useState("");
  return (
    <>
      <div className="plp-field">
        <label>{label}</label>
        <div className="plp-pw">
          <input
            name="password"
            type={showPw ? "text" : "password"}
            required
            placeholder="••••••••"
            autoComplete={autoComplete}
            autoFocus={autoFocus}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button type="button" className="plp-pw-toggle" onClick={onToggle}>
            {showPw ? "Hide" : "Show"}
          </button>
        </div>
      </div>
      {showRules && (
        <div className="plp-rules">
          <span className={value.length >= 8 ? "ok" : ""}>8+ characters</span>
          <span className={/[A-Za-z]/.test(value) ? "ok" : ""}>a letter</span>
          <span className={/\d/.test(value) ? "ok" : ""}>a number</span>
        </div>
      )}
    </>
  );
}

/* ---------------- Delivery details (profile and checkout share these fields and checks) ---------------- */
const readAddress = (form) => {
  const fd = new FormData(form);
  const v = (k) => String(fd.get(k) || "").trim();
  return { full_name: v("full_name"), phone: v("phone"), address_line: v("address_line"), city: v("city"), province: v("province"), postal_code: v("postal_code") };
};
const addressError = (a) => {
  if (a.full_name.length < 2) return "Please enter your full name.";
  if (!/^[-0-9+() ]{7,20}$/.test(a.phone)) return "Please enter a valid phone number.";
  if (a.address_line.length < 5) return "Please enter your street address.";
  if (a.city.length < 2) return "Please enter your city or municipality.";
  if (a.province.length < 2) return "Please enter your province.";
  if (!/^[A-Za-z0-9 -]{3,10}$/.test(a.postal_code)) return "Please enter a valid postal code.";
  return "";
};

const friendlyAuthError = (error) => {
  const m = (error?.message || "").toLowerCase();
  if (m.includes("invalid login")) return "Incorrect email or password.";
  if (m.includes("database error saving new user")) return EMAIL_RULE; // blocked by the database domain rule
  if (m.includes("error sending") || m.includes("sending confirmation") || m.includes("sending recovery"))
    return "We couldn't send your code right now. Please try again in a few minutes.";
  if (m.includes("banned")) return "This account has been disabled. Please contact support.";
  if (m.includes("different from the old password")) return "Your new password must be different from your old one.";
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

// Public web address of a product photo stored in Supabase Storage (the "products" folder)
const imageUrl = (path) => (path ? supabase.storage.from("products").getPublicUrl(path).data.publicUrl : null);

function ProductCard({ p, onOpen, onAdd }) {
  const src = imageUrl(p.image_path);
  return (
    <div className="plp-card">
      <div className="plp-card-media plp-photo" onClick={() => onOpen(p)}>
        {p.badge && <span className="plp-card-badge">{p.badge}</span>}
        {src ? <img src={src} alt={p.name} loading="lazy" /> : <BottleSVG />}
      </div>
      <div className="plp-card-body">
        <div className="plp-card-cat">{p.category || "Eau de Parfum"} · 50ml</div>
        <div className="plp-card-name" onClick={() => onOpen(p)}>{p.name}</div>
        <div className="plp-card-note">{p.notes}</div>
        <div className="plp-card-foot">
          <span className="plp-price">${p.price}</span>
          <button className="plp-add" onClick={() => onAdd(p.name, p.price)}>Add to bag</button>
        </div>
      </div>
    </div>
  );
}

function FeaturedSlideshow({ items, crest }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused || !items.length) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setI((n) => (n + 1) % items.length), 4000);
    return () => clearInterval(t);
  }, [paused, items.length]);
  if (!items.length) return null;
  const cur = i % items.length;
  return (
    <div className="plp-show" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className="plp-show-label">Featured fragrances</div>
      <div className="plp-show-stage">
        {items.map((p, n) => (
          <div key={p.name} className={"plp-slide" + (n === cur ? " on" : "")}>
            <div className="plp-slide-art">
              {p.image ? (
                <img src={p.image} alt={p.name} />
              ) : (
                <div className="plp-slide-ph">
                  <img src={crest} alt="" />
                  <span>Photo coming soon</span>
                </div>
              )}
            </div>
            <div>
              <div className="plp-slide-name">{p.name}</div>
              <div className="plp-slide-note">{p.note}</div>
              {p.price != null && <div className="plp-slide-price">${p.price}</div>}
            </div>
          </div>
        ))}
      </div>
      <div className="plp-dots">
        {items.map((p, n) => (
          <button key={p.name} aria-label={"Show " + p.name} className={n === cur ? "on" : ""} onClick={() => setI(n)} />
        ))}
      </div>
    </div>
  );
}

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
  const [profile, setProfile] = useState({}); // name, phone and address saved on the account
  const [profileMsg, setProfileMsg] = useState("");
  const [checkoutMsg, setCheckoutMsg] = useState("");

  // Admins never use the customer storefront: as soon as we know the account is an admin, go to /admin.
  const router = useRouter();
  useEffect(() => {
    if (role === "admin") router.replace("/admin");
  }, [role, router]);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false); // mobile menu
  const [showPw, setShowPw] = useState(false); // show/hide password
  const [authEmail, setAuthEmail] = useState(""); // email the 6-digit code was sent to
  const [codeMode, setCodeMode] = useState("signup"); // "signup" | "recovery"
  const [codeMsg, setCodeMsg] = useState("");
  const [forgotMsg, setForgotMsg] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0); // seconds until "Resend code" works again
  const [resetPending, setResetPending] = useState(false); // code verified, new password not chosen yet
  const [newpassMsg, setNewpassMsg] = useState("");
  const [signinPrefill, setSigninPrefill] = useState(""); // email pre-filled on the sign-in form after a reset

  // If someone closes the popup before choosing a new password, they are NOT left signed in.
  useEffect(() => {
    if (resetPending && openModalId !== "newpass") {
      setResetPending(false);
      supabase.auth.signOut();
      setRemember(false);
    }
  }, [openModalId, resetPending]);

  /* ---------------- Login first ---------------- */
  const [authReady, setAuthReady] = useState(false); // becomes true once we know if someone is already signed in
  // "booting": we don't know yet who is here (or the role is still loading), so show only the logo
  const booting = REQUIRE_LOGIN && (!authReady || (user && role === null));
  // "gated": nobody is signed in (or a password reset is half done), so show only the login panel
  const gated = REQUIRE_LOGIN && authReady && (!user || resetPending);
  useEffect(() => {
    if (gated && openModalId === null) setOpenModalId("signin");
  }, [gated, openModalId]);

  /* ---------------- Products come from the database (admins edit them on /admin) ---------------- */
  const [products, setProducts] = useState([]);
  const [productsState, setProductsState] = useState("loading"); // loading | ready | error
  const [selected, setSelected] = useState(null); // product shown in the detail popup
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [sort, setSort] = useState("featured");
  const [visible, setVisible] = useState(12);
  const loadProducts = async () => {
    setProductsState("loading");
    const { data, error } = await supabase
      .from("products")
      .select("id, name, category, price, badge, notes, description, image_path, featured, sort_order")
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });
    if (error) return setProductsState("error");
    setProducts(data || []);
    setProductsState("ready");
  };
  useEffect(() => {
    loadProducts();
  }, []);
  const openProduct = (p) => {
    setSelected(p);
    setOpenModalId("product");
  };

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  /* ---------------- Auth: keep `user` and `role` in sync with Supabase ---------------- */
  useEffect(() => {
    const loadRole = async (u) => {
      if (!u) {
        setRole(null);
        setProfile({});
        return;
      }
      const { data } = await supabase
        .from("profiles")
        .select("role, full_name, phone, address_line, city, province, postal_code")
        .eq("id", u.id)
        .single();
      setRole(data?.role ?? "customer");
      setProfile(data || {});
    };
    if (rememberExpired()) {
      // "Remember me" lasted 30 days: sign out so the user logs in again
      supabase.auth.signOut();
      setRemember(false);
    }
    const bootTimer = setTimeout(() => setAuthReady(true), 4000); // safety net if Supabase is unreachable
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthReady(true);
      setUser(session?.user ?? null);
      setTimeout(() => loadRole(session?.user), 0); // setTimeout avoids a known Supabase deadlock
    });
    return () => {
      clearTimeout(bootTimer);
      sub.subscription.unsubscribe();
    };
  }, []);
  const [toast, setToast] = useState({ show: false, text: "" });
  const toastTimer = useRef(null);

  const sectionRefs = {
    top: useRef(null),
    productsSection: useRef(null),
    collectionSection: useRef(null),
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
  const orderTotal = cart.reduce((sum, i) => sum + i.price * i.qty, 0);
  const cartSubtotal = cart.reduce((sum, i) => sum + i.qty * i.price, 0);

  /* ---------------- Checkout: review order + delivery address, then place the order ---------------- */
  const handleCheckout = (e) => {
    e.preventDefault();
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
    setCheckoutMsg("");
    setCartOpen(false);
    openModal("checkout");
  };

  const saveProfile = (a) =>
    supabase.rpc("update_profile", {
      p_full_name: a.full_name,
      p_phone: a.phone,
      p_address_line: a.address_line,
      p_city: a.city,
      p_province: a.province,
      p_postal_code: a.postal_code,
    });

  const handlePlaceOrder = async (e) => {
    e.preventDefault();
    if (checkoutLoading) return;
    const form = e.target;
    const a = readAddress(form);
    const err = addressError(a);
    if (err) return setCheckoutMsg(err);
    const saveAsDefault = new FormData(form).get("save_default") === "on";

    setCheckoutLoading(true);
    setCheckoutMsg("");
    // Only names + quantities are sent; the database looks up the real prices.
    const { data, error } = await supabase.rpc("place_order", {
      p_items: cart.map((i) => ({ name: i.name, qty: i.qty })),
      p_shipping: a,
    });
    if (error) {
      setCheckoutLoading(false);
      return setCheckoutMsg(error.message);
    }
    if (saveAsDefault) {
      await saveProfile(a);
      setProfile((p) => ({ ...p, ...a }));
    }
    setCheckoutLoading(false);
    setCart([]);
    showInfo(
      "Order placed",
      `Thank you! Your order ${data.order_no} has been placed and is awaiting confirmation. Total: $${data.total}. We'll deliver to ${a.address_line}, ${a.city}.`
    );
  };

  /* ---------------- Profile ---------------- */
  const handleSaveProfile = async (e) => {
    e.preventDefault();
    if (authBusy) return;
    const a = readAddress(e.target);
    const err = addressError(a);
    if (err) return setProfileMsg(err);
    setAuthBusy(true);
    setProfileMsg("Saving…");
    const { error } = await saveProfile(a);
    setAuthBusy(false);
    if (error) return setProfileMsg(error.message);
    setProfile((p) => ({ ...p, ...a }));
    setProfileMsg("");
    closeModal();
    showToast("Profile saved.");
  };

  const renderAddressFields = (p) => (
    <>
      <div className="plp-field">
        <label>Full name</label>
        <input name="full_name" type="text" defaultValue={p.full_name || ""} placeholder="Jane Doe" autoComplete="name" />
      </div>
      <div className="plp-field">
        <label>Phone</label>
        <input name="phone" type="tel" defaultValue={p.phone || ""} placeholder="0917 123 4567" autoComplete="tel" />
      </div>
      <div className="plp-field">
        <label>Address</label>
        <input name="address_line" type="text" defaultValue={p.address_line || ""} placeholder="House no., street, barangay" autoComplete="street-address" />
      </div>
      <div className="plp-two">
        <div className="plp-field">
          <label>City / Municipality</label>
          <input name="city" type="text" defaultValue={p.city || ""} autoComplete="address-level2" />
        </div>
        <div className="plp-field">
          <label>Province</label>
          <input name="province" type="text" defaultValue={p.province || ""} autoComplete="address-level1" />
        </div>
      </div>
      <div className="plp-field">
        <label>Postal code</label>
        <input name="postal_code" type="text" inputMode="numeric" maxLength={10} defaultValue={p.postal_code || ""} autoComplete="postal-code" />
      </div>
    </>
  );

  /* ---------------- Modals ---------------- */
  const openModal = (id) => setOpenModalId(id);
  const closeModal = () => setOpenModalId(null);

  // Close a popup only when the press AND the release both happen on the dark background.
  // (Pressing inside the panel, e.g. to select text, then letting go outside no longer closes it.)
  const pressStartedOnOverlay = useRef(false);
  const overlayProps = {
    onPointerDown: (e) => {
      pressStartedOnOverlay.current = e.target === e.currentTarget;
    },
    onClick: (e) => {
      if (pressStartedOnOverlay.current && e.target === e.currentTarget) closeModal();
      pressStartedOnOverlay.current = false;
    },
  };
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
    setSigninPrefill("");
    setSigninMsg("Signed in. Welcome back!");
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
    const code = String(new FormData(e.target).get("code")).replace(/\D/g, "");
    if (code.length !== 6) return setCodeMsg("Enter the 6-digit code from your email.");

    setAuthBusy(true);
    setCodeMsg("Checking your code…");
    // New accounts stay signed in for 30 days; a password reset must NOT leave anyone signed in.
    setRemember(codeMode !== "recovery");
    const { error } = await supabase.auth.verifyOtp({
      email: authEmail,
      token: code,
      type: codeMode === "recovery" ? "recovery" : "signup",
    });
    setAuthBusy(false);
    if (error) return setCodeMsg("That code is incorrect or has expired. You can request a new one below.");

    setCodeMsg("");
    if (codeMode === "recovery") {
      setNewpassMsg("");
      setResetPending(true);
      return openModal("newpass"); // step 2: choose the new password
    }
    closeModal();
    showToast("Email confirmed. Welcome!");
  };

  const handleNewPassword = async (e) => {
    e.preventDefault();
    if (authBusy) return;
    const password = String(new FormData(e.target).get("password"));
    if (!validPassword(password)) return setNewpassMsg(PASSWORD_RULE);

    setAuthBusy(true);
    setNewpassMsg("Saving your new password…");
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setAuthBusy(false);
      return setNewpassMsg(friendlyAuthError(error));
    }
    setResetPending(false);
    await supabase.auth.signOut(); // finish signed out: sign in with the new password
    setRemember(false);
    setAuthBusy(false);
    setNewpassMsg("");
    setSigninPrefill(authEmail);
    openModal("signin");
    setSigninMsg("Password updated. Please sign in with your new password.");
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
    setCart([]);
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
  const featuredList = (products.some((p) => p.featured) ? products.filter((p) => p.featured) : products).slice(0, 8);
  const slides = featuredList.slice(0, 5).map((p) => ({ name: p.name, note: p.notes, price: p.price, image: imageUrl(p.image_path) }));
  const categories = ["All", ...Array.from(new Set(products.map((p) => p.category).filter(Boolean))).sort()];
  const searchText = search.trim().toLowerCase();
  const filtered = products
    .filter(
      (p) =>
        (category === "All" || p.category === category) &&
        (!searchText || [p.name, p.notes, p.category].some((t) => (t || "").toLowerCase().includes(searchText)))
    )
    .sort((a, b) =>
      sort === "low" ? a.price - b.price : sort === "high" ? b.price - a.price : sort === "az" ? a.name.localeCompare(b.name) : 0
    );

  // Shown for a moment while an admin is being sent to /admin (all hooks are above this line)
  if (role === "admin") {
    return (
      <div style={{ minHeight: "100vh", background: "#121210", color: "#c9c3b4", display: "grid", placeItems: "center",
        fontFamily: "'Jost', sans-serif", fontSize: 12, letterSpacing: "0.25em", textTransform: "uppercase" }}>
        Opening admin…
      </div>
    );
  }

  return (
    <div className={"plp-root" + (booting || gated ? " plp-gated" : "")}>
      {booting && (
        <div className="plp-gate-brand">
          <img src={crest} alt="Prestige Le Parfum" />
          <div>Prestige Le Parfum</div>
        </div>
      )}
      {gated && (
        <div className="plp-gate-hero">
          <img className="plp-gate-logo" src={crest} alt="Prestige Le Parfum crest" />
          <h1 className="plp-gate-title">Prestige<br />Le Parfum</h1>
          <p className="plp-gate-tag">Rare ingredients, hand-finished bottles.</p>
          <FeaturedSlideshow items={slides} crest={crest} />
        </div>
      )}
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

        /* LOGIN FIRST: while nobody is signed in, hide the whole store and show only the login panel */
        .plp-gated > *:not(style):not(.plp-overlay):not(.plp-gate-brand):not(.plp-gate-hero){display:none !important;}
        .plp-gated .plp-modal-close{display:none;}
        .plp-gated .plp-modal::before{display:none;}
        .plp-gate-brand{position:fixed; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px;
          color:var(--cream); font-family:'Cormorant Garamond',serif; font-size:22px; letter-spacing:0.3em; text-transform:uppercase;}
        .plp-gate-brand img{height:64px;}

        /* login screen: logo + big title + slideshow on the left, login panel on the right */
        .plp-gate-hero{position:fixed; top:0; left:0; bottom:0; width:46%; z-index:5; overflow-y:auto;
          padding:6vh 3vw 5vh 5vw; display:flex; flex-direction:column; justify-content:center;
          background:radial-gradient(120% 90% at 0% 0%, rgba(201,162,75,0.10), transparent 60%);}
        .plp-gate-logo{height:76px; width:auto; align-self:flex-start; margin-bottom:26px;}
        .plp-gate-title{font-family:'Cormorant Garamond',serif; font-weight:500; font-size:clamp(48px,6.2vw,92px);
          line-height:0.95; letter-spacing:0.02em; text-transform:uppercase; margin:0 0 14px; color:var(--cream);}
        .plp-gate-tag{font-size:12px; letter-spacing:0.18em; text-transform:uppercase; color:var(--gold-soft); margin:0 0 4vh;}
        .plp-show{max-width:440px;}
        .plp-show-label{font-size:10px; letter-spacing:0.3em; text-transform:uppercase; color:var(--stone); margin-bottom:12px;}
        .plp-show-stage{position:relative; height:170px;}
        .plp-slide{position:absolute; inset:0; display:flex; gap:18px; align-items:center; opacity:0; transform:translateX(14px);
          transition:opacity .6s, transform .6s; pointer-events:none;}
        .plp-slide.on{opacity:1; transform:none; pointer-events:auto;}
        .plp-slide-art{flex:0 0 130px; height:170px; border:1px solid var(--gold-line); overflow:hidden;
          background:linear-gradient(160deg,#1c1c18,#121210); display:flex; align-items:center; justify-content:center;}
        .plp-slide-art > img{width:100%; height:100%; object-fit:cover;}
        .plp-slide-ph{display:flex; flex-direction:column; align-items:center; gap:10px; padding:8px; text-align:center;
          font-size:10px; letter-spacing:0.14em; text-transform:uppercase; color:var(--stone);}
        .plp-slide-ph img{width:44px; opacity:.55;}
        .plp-slide-name{font-family:'Cormorant Garamond',serif; font-size:28px; color:var(--cream);}
        .plp-slide-note{font-size:13px; color:var(--cream-dim); margin-top:4px;}
        .plp-slide-price{font-family:'Cormorant Garamond',serif; font-size:22px; color:var(--gold-soft); margin-top:10px;}
        .plp-dots{display:flex; gap:10px; margin-top:12px;}
        .plp-dots button{width:28px; height:18px; padding:8px 0; border:none; background:var(--gold-line); background-clip:content-box; cursor:pointer;}
        .plp-dots button.on{background:var(--gold); background-clip:content-box;}
        @media (prefers-reduced-motion:reduce){ .plp-slide{transition:none;} }
        @media (min-width:981px){
          .plp-gated .plp-overlay{left:46%; background:transparent; backdrop-filter:none; -webkit-backdrop-filter:none;}
        }
        @media (max-width:980px){
          .plp-gate-hero{width:100%; bottom:auto; flex-direction:row; align-items:center; justify-content:flex-start; gap:14px;
            padding:max(14px, env(safe-area-inset-top)) 20px 12px; background:none; overflow:visible;}
          .plp-gate-logo{height:42px; margin:0;}
          .plp-gate-title{font-size:clamp(15px,4.6vw,22px); margin:0; letter-spacing:0.12em;}
          .plp-gate-title br,.plp-gate-tag,.plp-show{display:none;}
          .plp-gated .plp-overlay{top:78px;}
          .plp-gated .plp-modal{max-height:calc(100dvh - 100px);}
        }
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
          /* swipe left and right through the cards (the page itself still scrolls up and down) */
          .plp-grid,.plp-blog-grid{
            display:flex; gap:16px; overflow-x:auto; overflow-y:hidden;
            scroll-snap-type:x mandatory; -webkit-overflow-scrolling:touch; scrollbar-width:none;
            margin-left:-20px; margin-right:-20px; padding:0 20px 14px; scroll-padding:0 20px;
          }
          .plp-grid::-webkit-scrollbar,.plp-blog-grid::-webkit-scrollbar{display:none;}
          .plp-grid > *,.plp-blog-grid > *{flex:0 0 78%; scroll-snap-align:start;}
          .plp-card-media{height:200px;}
          .plp-card-media.plp-photo{height:auto;}
          /* the full collection is a 2-column grid on phones; chips swipe sideways */
          .plp-catalog{grid-template-columns:repeat(2,1fr); gap:12px;}
          .plp-catalog .plp-card-body{padding:12px;}
          .plp-catalog .plp-card-foot{flex-direction:column; align-items:stretch; gap:8px;}
          .plp-catalog .plp-card-name{font-size:18px;}
          .plp-catalog .plp-card-note{display:none;}
          .plp-chips{flex-wrap:nowrap; overflow-x:auto; scrollbar-width:none; margin-left:-20px; margin-right:-20px; padding:0 20px 6px;}
          .plp-chips::-webkit-scrollbar{display:none;}
          .plp-chip{flex:0 0 auto;}
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

        /* PRODUCT PHOTOS (white background photos sit on a clean white panel) */
        .plp-card-media.plp-photo{background:#fff; height:auto; aspect-ratio:3/4; cursor:pointer; display:flex; align-items:center; justify-content:center; overflow:hidden; position:relative;}
        .plp-photo img{width:100%; height:100%; object-fit:contain; padding:12px; box-sizing:border-box; transition:transform .5s;}
        .plp-card:hover .plp-photo img{transform:scale(1.05);}
        .plp-card-name{cursor:pointer;}
        .plp-state{color:var(--cream-dim); font-size:14px; padding:10px 0 24px;}
        .plp-state a{color:var(--gold-soft); cursor:pointer; text-decoration:underline;}
        .plp-count{font-size:12px; letter-spacing:0.18em; text-transform:uppercase; color:var(--stone);}
        .plp-toolbar{display:flex; gap:14px; flex-wrap:wrap; margin-bottom:18px;}
        .plp-search,.plp-sort{background:rgba(255,255,255,0.03); border:1px solid var(--gold-line); color:var(--cream); font-family:'Jost',sans-serif;
          font-size:14px; padding:12px 14px; outline:none;}
        .plp-search{flex:1; min-width:220px;}
        .plp-sort option{background:#121210;}
        .plp-search:focus,.plp-sort:focus{border-color:var(--gold);}
        .plp-chips{display:flex; gap:8px; flex-wrap:wrap; margin-bottom:28px;}
        .plp-chip{background:none; border:1px solid var(--gold-line); color:var(--cream-dim); font-family:'Jost',sans-serif; font-size:11px;
          letter-spacing:0.16em; text-transform:uppercase; padding:9px 16px; cursor:pointer;}
        .plp-chip:hover{border-color:var(--gold);}
        .plp-chip.on{border-color:var(--gold); color:var(--gold-soft);}
        .plp-catalog{display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:24px; max-width:1180px; margin:0 auto;}
        .plp-more{display:block; margin:36px auto 0; background:none; border:1px solid var(--gold); color:var(--gold-soft); font-family:'Jost',sans-serif;
          font-size:12px; letter-spacing:0.2em; text-transform:uppercase; padding:14px 34px; cursor:pointer;}
        .plp-more:hover{background:var(--gold); color:#121210;}
        .plp-modal-wide{max-width:780px; width:92vw;}
        .plp-pd{display:grid; grid-template-columns:1fr 1fr; gap:28px; align-items:center;}
        .plp-pd-img{background:#fff; aspect-ratio:3/4; display:flex; align-items:center; justify-content:center; overflow:hidden;}
        .plp-pd-img img{width:100%; height:100%; object-fit:contain; padding:14px; box-sizing:border-box;}
        .plp-pd h3{font-family:'Cormorant Garamond',serif; font-weight:500; font-size:34px; margin:6px 0 10px;}
        .plp-pd-price{font-family:'Cormorant Garamond',serif; font-size:28px; color:var(--gold-soft); margin-bottom:14px;}
        .plp-pd-notes{font-size:13px; color:var(--cream-dim); margin:0 0 10px;}
        .plp-pd-notes span{font-size:10px; letter-spacing:0.2em; text-transform:uppercase; color:var(--stone); margin-right:6px;}
        .plp-pd-text{font-size:14px; line-height:1.7; color:var(--cream-dim); margin:0 0 22px;}
        @media (max-width:700px){ .plp-pd{grid-template-columns:1fr;} .plp-pd-img{max-height:300px; aspect-ratio:auto; height:300px;} }
        .plp-two{display:grid; grid-template-columns:1fr 1fr; gap:0 12px;}
        @media (max-width:600px){ .plp-two{grid-template-columns:1fr;} }
        .plp-fieldmsg{font-size:12px; margin-top:6px;}
        .plp-fieldmsg.bad{color:#e0907f;}
        .plp-fieldmsg.ok{color:#8fc79a;}
        .plp-fieldmsg.hint{color:var(--stone);}
        .plp-fieldmsg a{color:var(--gold-soft); cursor:pointer; text-decoration:underline;}
        .plp-field input.plp-invalid{border-color:#e0907f;}
        .plp-field input.plp-valid{border-color:#8fc79a;}
        .plp-rules{display:flex; gap:6px 16px; flex-wrap:wrap; font-size:12px; color:var(--stone); margin:-6px 0 18px;}
        .plp-rules span::before{content:"○ ";}
        .plp-rules span.ok{color:#8fc79a;}
        .plp-rules span.ok::before{content:"✓ ";}
        .plp-summary{border:1px solid var(--gold-line); padding:14px 16px; margin:18px 0 22px; font-size:13px; color:var(--cream-dim);}
        .plp-summary-row{display:flex; justify-content:space-between; gap:12px; padding:5px 0;}
        .plp-summary-total{border-top:1px solid var(--gold-line); margin-top:8px; padding-top:12px; color:var(--cream); font-size:15px;}
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
        <div className="plp-overlay" {...overlayProps}>
          <div className="plp-modal">
            <button className="plp-modal-close" onClick={closeModal}>&times;</button>
            <h3>Sign in</h3>
            <div className="plp-sub">Access your account, orders and wishlist.</div>
            <form onSubmit={handleSignin} noValidate>
              <EmailField defaultValue={signinPrefill} />
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
        <div className="plp-overlay" {...overlayProps}>
          <div className="plp-modal">
            <button className="plp-modal-close" onClick={closeModal}>&times;</button>
            <h3>Create account</h3>
            <div className="plp-sub">Use a valid Gmail, Outlook, Yahoo, iCloud, Proton or @tip.edu.ph email. We'll send you a 6-digit code to verify it.</div>
            <form onSubmit={handleCreateAccount} noValidate>
              <div className="plp-field">
                <label>Full name</label>
                <input name="full_name" type="text" required placeholder="Jane Doe" autoComplete="name" />
              </div>
              <EmailField />
              <PasswordField autoComplete="new-password" showPw={showPw} onToggle={() => setShowPw((v) => !v)} showRules />
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
        <div className="plp-overlay" {...overlayProps}>
          <div className="plp-modal">
            <button className="plp-modal-close" onClick={closeModal}>&times;</button>
            <h3>Forgot password</h3>
            <div className="plp-sub">Enter your email and we'll send you a 6-digit code.</div>
            <form onSubmit={handleForgot} noValidate>
              <EmailField autoFocus />
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
        <div className="plp-overlay" {...overlayProps}>
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
              <button type="submit" className="plp-btn" style={{ width: "100%" }} disabled={authBusy}>
                {codeMode === "recovery" ? "Verify code" : "Verify and continue"}
              </button>
              {codeMsg && <div className="plp-modal-msg">{codeMsg}</div>}
            </form>
            <div className="plp-switch-line">
              Didn't get it? {cooldown > 0 ? <span>Resend in {cooldown}s</span> : <a onClick={handleResend}>Resend code</a>}
            </div>
          </div>
        </div>
      )}

      {openModalId === "newpass" && (
        <div className="plp-overlay" {...overlayProps}>
          <div className="plp-modal">
            <button className="plp-modal-close" onClick={closeModal}>&times;</button>
            <h3>Choose a new password</h3>
            <div className="plp-sub">Your code is verified. Pick a new password for {authEmail}.</div>
            <form onSubmit={handleNewPassword} noValidate>
              <PasswordField label="New password" autoComplete="new-password" autoFocus showPw={showPw} onToggle={() => setShowPw((v) => !v)} showRules />
              <button type="submit" className="plp-btn" style={{ width: "100%" }} disabled={authBusy}>Update password</button>
              {newpassMsg && <div className="plp-modal-msg">{newpassMsg}</div>}
            </form>
          </div>
        </div>
      )}

      {openModalId === "signout" && (
        <div className="plp-overlay" {...overlayProps}>
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

      {openModalId === "checkout" && (
        <div className="plp-overlay" {...overlayProps}>
          <div className="plp-modal">
            <button className="plp-modal-close" onClick={closeModal}>&times;</button>
            <h3>Checkout</h3>
            <div className="plp-sub">Review your order and confirm where to deliver it.</div>
            <div className="plp-summary">
              {cart.map((i) => (
                <div className="plp-summary-row" key={i.name}>
                  <span>{i.name} &times; {i.qty}</span>
                  <span>${i.price * i.qty}</span>
                </div>
              ))}
              <div className="plp-summary-row plp-summary-total">
                <span>Total</span>
                <span>${orderTotal}</span>
              </div>
            </div>
            <form onSubmit={handlePlaceOrder} noValidate>
              {renderAddressFields(profile)}
              <label className="plp-check" style={{ margin: "2px 0 18px" }}>
                <input type="checkbox" name="save_default" defaultChecked /> Save as my default address
              </label>
              <button type="submit" className="plp-btn" style={{ width: "100%" }} disabled={checkoutLoading}>
                {checkoutLoading ? "Placing order…" : "Place order"}
              </button>
              {checkoutMsg && <div className="plp-modal-msg">{checkoutMsg}</div>}
            </form>
          </div>
        </div>
      )}

      {openModalId === "profile" && (
        <div className="plp-overlay" {...overlayProps}>
          <div className="plp-modal">
            <button className="plp-modal-close" onClick={closeModal}>&times;</button>
            <h3>Your profile</h3>
            <div style={{ height: 16 }} />
            <form onSubmit={handleSaveProfile} noValidate>
              <div className="plp-field">
                <label>Email</label>
                <input type="email" value={user?.email || ""} disabled readOnly style={{ opacity: 0.6 }} />
              </div>
              {renderAddressFields(profile)}
              <button type="submit" className="plp-btn" style={{ width: "100%" }} disabled={authBusy}>Save profile</button>
              {profileMsg && <div className="plp-modal-msg">{profileMsg}</div>}
            </form>
          </div>
        </div>
      )}

      {openModalId === "product" && selected && (
        <div className="plp-overlay" {...overlayProps}>
          <div className="plp-modal plp-modal-wide">
            <button className="plp-modal-close" onClick={closeModal}>&times;</button>
            <div className="plp-pd">
              <div className="plp-pd-img">
                {imageUrl(selected.image_path) ? <img src={imageUrl(selected.image_path)} alt={selected.name} /> : <BottleSVG />}
              </div>
              <div>
                <div className="plp-card-cat">{selected.category || "Eau de Parfum"} · 50ml</div>
                <h3>{selected.name}</h3>
                <div className="plp-pd-price">${selected.price}</div>
                {selected.notes && <p className="plp-pd-notes"><span>Notes</span> {selected.notes}</p>}
                <p className="plp-pd-text">{selected.description || "An eau de parfum from our collection, available in 50ml."}</p>
                <button className="plp-btn" style={{ width: "100%" }} onClick={() => addToCart(selected.name, selected.price)}>
                  Add to bag
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {openModalId === "tracking" && (
        <div className="plp-overlay" {...overlayProps}>
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
        <div className="plp-overlay" {...overlayProps}>
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
            <a onClick={() => scrollToSection("collectionSection")}>Products</a>
            <a onClick={() => scrollToSection("storySection")}>Collections</a>
            <a onClick={() => scrollToSection("blogSection")}>Blog</a>
            <a onClick={() => openModal("tracking")}>Order Tracking</a>
            {user && <a onClick={() => openModal("profile")}>Profile</a>}
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
              <a className="plp-btn" onClick={() => scrollToSection("collectionSection")}>Shop the collection</a>
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

      {/* ---------- Featured ---------- */}
      <section className="plp-section" ref={sectionRefs.productsSection}>
        <div className="plp-section-head">
          <div>
            <div className="eyebrow">Best sellers</div>
            <h2>Signature edition</h2>
          </div>
          <a className="plp-view-all" onClick={() => scrollToSection("collectionSection")}>
            View all products
          </a>
        </div>
        {productsState === "loading" && <p className="plp-state">Loading the collection…</p>}
        {productsState === "error" && (
          <p className="plp-state">
            We couldn&apos;t load the collection. <a onClick={loadProducts}>Try again</a>
          </p>
        )}
        <div className="plp-grid">
          {featuredList.map((p) => (
            <ProductCard key={p.id} p={p} onOpen={openProduct} onAdd={addToCart} />
          ))}
        </div>
      </section>

      {/* ---------- Full collection ---------- */}
      <section className="plp-section" ref={sectionRefs.collectionSection}>
        <div className="plp-section-head">
          <div>
            <div className="eyebrow">The full range</div>
            <h2>The collection</h2>
          </div>
          <span className="plp-count">{filtered.length} fragrance{filtered.length === 1 ? "" : "s"}</span>
        </div>
        <div className="plp-toolbar">
          <input
            className="plp-search"
            type="search"
            placeholder="Search by name, scent or category"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setVisible(12); }}
          />
          <select className="plp-sort" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="featured">Featured</option>
            <option value="low">Price: Low to High</option>
            <option value="high">Price: High to Low</option>
            <option value="az">Name: A to Z</option>
          </select>
        </div>
        <div className="plp-chips">
          {categories.map((c) => (
            <button key={c} className={"plp-chip" + (c === category ? " on" : "")} onClick={() => { setCategory(c); setVisible(12); }}>
              {c}
            </button>
          ))}
        </div>
        {filtered.length === 0 && productsState === "ready" ? (
          <p className="plp-state">No fragrances match your search.</p>
        ) : (
          <div className="plp-catalog">
            {filtered.slice(0, visible).map((p) => (
              <ProductCard key={p.id} p={p} onOpen={openProduct} onAdd={addToCart} />
            ))}
          </div>
        )}
        {filtered.length > visible && (
          <button className="plp-more" onClick={() => setVisible((v) => v + 12)}>Show more</button>
        )}
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
            <a onClick={() => scrollToSection("collectionSection")}>All products</a>
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