import { createClient } from "@supabase/supabase-js";

/* "Remember me":
   - ticked      -> login is kept in localStorage and expires after 30 days
   - not ticked  -> login is kept in sessionStorage (gone when the tab/browser is closed)
   The 30-day limit is enforced by this website (see rememberExpired). */
const FLAG = "plp-remember-until"; // timestamp (ms) when a remembered login ends; "0" = not remembered
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const isBrowser = typeof window !== "undefined";

export function setRemember(remember) {
  if (!isBrowser) return;
  localStorage.setItem(FLAG, remember ? String(Date.now() + THIRTY_DAYS) : "0");
}

export function rememberExpired() {
  if (!isBrowser) return false;
  const until = Number(localStorage.getItem(FLAG) || 0);
  return until > 0 && Date.now() > until;
}

const storage = {
  getItem: (key) => (isBrowser ? localStorage.getItem(key) ?? sessionStorage.getItem(key) : null),
  setItem: (key, value) => {
    if (!isBrowser) return;
    const remembered = Number(localStorage.getItem(FLAG) || 0) > 0;
    (remembered ? localStorage : sessionStorage).setItem(key, value);
    (remembered ? sessionStorage : localStorage).removeItem(key);
  },
  removeItem: (key) => {
    if (!isBrowser) return;
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  },
};

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { auth: { storage } }
);