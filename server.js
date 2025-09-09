// server.js (ESM) — chapterMap + diagnostics + SEARCH + dummy auth (cookie session) + smart chapter fallback
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

/* --- FIX: favicon short-circuit (hindari nyangkut ke /:chapterId) --- */
app.get("/favicon.ico", (_req, res) => res.status(204).end());

// ------- In-memory "database" & session store (DEMO only) -------
const users = new Map(); // key: email, value: { email, username, password }
const sessions = new Map(); // key: token, value: { email, username }

// Views
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Static + middlewares
app.use(express.static(path.join(__dirname, "public"), { maxAge: "7d" }));
app.use(express.urlencoded({ extended: true })); // parse form body
app.use(cookieParser("very-secret-demo"));       // read signed cookies
app.use(compression());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Non-strict CSP (allow CDNs while developing)
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    crossOriginResourcePolicy: { policy: "cross-origin" },
    referrerPolicy: { policy: "no-referrer" },
  })
);

// Simple request logger for visibility
app.use((req, _res, next) => {
  console.log(`[req] ${req.method} ${req.url}`);
  next();
});

// ----- attach user from session cookie -----
app.use((req, res, next) => {
  const token = req.signedCookies?.sid;
  let user = null;
  if (token && sessions.has(token)) {
    user = sessions.get(token);
  }
  req.user = user;
  res.locals.user = user; // available in EJS
  next();
});

// Helpers
async function fetchJSON(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      const err = new Error(`HTTP ${res.status} ${res.statusText} — ${t.slice(0, 120)}`);
      err.status = res.status;                 // <-- FIX: bawa status code
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

// fetch 3 latest chapters per id from detail endpoint
async function getLatestChaptersFor(ids) {
  const tasks = ids.map((id) =>
    fetchJSON(`https://lk21.imgdesu.art/api/manga/detail/${encodeURIComponent(id)}`)
      .then((d) => ({
        id,
        chapters: (d.chapters || []).slice(0, 3).map((c) => ({
          title: c.title || (c.number ? `Chapter ${c.number}` : "Chapter"),
          number: c.number || "",
          date: c.date || "",
          chapterId: c.chapterId || "",
          url: c.url || "",
        })),
      }))
      .catch((err) => {
        console.warn("[detail-failed]", id, err.message);
        return { id, chapters: [] };
      })
  );
  const settled = await Promise.allSettled(tasks);
  const map = {};
  for (const r of settled) {
    if (r.status === "fulfilled") map[r.value.id] = r.value.chapters;
  }
  return map;
}

// Smart chapter fetch: try ID, if 404 then find real id from series detail
async function fetchChapterSmart(chapterId) {
  const base = "https://lk21.imgdesu.art";
  try {
    return await fetchJSON(`${base}/api/manga/chapter/${encodeURIComponent(chapterId)}`);
  } catch (e) {
    if (!(String(e.message).includes("404") || e.status === 404)) throw e;
    // infer slug from pattern "...-chapter-XX"
    const m = chapterId.match(/^(.+)-chapter-\d+$/);
    if (!m) throw e;
    const slug = m[1];
    const det = await fetchJSON(`${base}/api/manga/detail/${encodeURIComponent(slug)}`);
    const list = det.chapters || [];
    const tail = (s) => (s || "").split("/").filter(Boolean).pop();
    const found = list.find((c) => c.chapterId === chapterId || tail(c.url) === chapterId);
    if (found?.chapterId) {
      return await fetchJSON(`${base}/api/manga/chapter/${encodeURIComponent(found.chapterId)}`);
    }
    throw e;
  }
}

// Routes
app.get("/", async (req, res) => {
  const page = Number(req.query.page || 1);
  const q = String(req.query.q || "").trim().toLowerCase(); // SEARCH

  try {
    const data = await fetchJSON(`https://lk21.imgdesu.art/api/manga/update?page=${page}`);
    // list dari API
    let list = data.mangaList || [];

    // filter by query q (judul)
    if (q) {
      list = list.filter((it) => (it.title || "").toLowerCase().includes(q));
    }

    // subset “terbaru” untuk ambil chapter detail (ikuti layout)
    const terbaru = list.slice(10, 26);
    const chapterMap = await getLatestChaptersFor(terbaru.map((x) => x.id));

    console.log(
      "[home]",
      "page=", page,
      "| q=", q || "-",
      "| list=", list.length,
      "| terbaru=", terbaru.length,
      "| chapterMap keys=", Object.keys(chapterMap).length,
      "| user=", req.user?.email || "-"
    );

    res.render("index", {
      pageTitle: "Manga Updates",
      mangaList: list,
      pagination: data.pagination || null,
      chapterMap,
      query: q,
    });
  } catch (e) {
    console.error("[home-error]", e);
    res.status(502).render("error", { pageTitle: "Error", message: "Gagal memuat beranda: " + e.message });
  }
});

// Diagnostics
app.get("/diag", async (_req, res) => {
  try {
    const data = await fetchJSON(`https://lk21.imgdesu.art/api/manga/update?page=1`);
    const list = data.mangaList || [];
    const terbaru = list.slice(10, 26);
    const chapterMap = await getLatestChaptersFor(terbaru.map((x) => x.id));
    res.json({
      updateCount: list.length,
      terbaruCount: terbaru.length,
      chapterMapKeys: Object.keys(chapterMap).length,
      sampleId: terbaru[0]?.id || null,
      sampleChapters: (chapterMap[terbaru[0]?.id] || []).slice(0, 3),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/series/:slug", async (req, res) => {
  try {
    const data = await fetchJSON(`https://lk21.imgdesu.art/api/manga/detail/${encodeURIComponent(req.params.slug)}`);
    res.render("series", { pageTitle: data?.title || req.params.slug, series: data });
  } catch (e) {
    console.error("[series-error]", e);
    if (e.status === 404 || String(e.message).includes("404")) {
      return res.status(404).render("error", { pageTitle: "404", message: "Seri tidak ditemukan." });
    }
    res.status(502).render("error", { pageTitle: "Error", message: "Gagal memuat seri: " + e.message });
  }
});

/* --- FIX: batasi pattern chapterId agar tidak match ".ico" / ber-titik --- */
app.get("/:chapterId([A-Za-z0-9-]+)", async (req, res) => {
  try {
    const data = await fetchChapterSmart(req.params.chapterId);
    res.render("chapter", { pageTitle: data?.title || req.params.chapterId, chapter: data });
  } catch (e) {
    console.error("[chapter-error]", e);
    if (e.status === 404 || String(e.message).includes("404")) {
      return res.status(404).render("error", { pageTitle: "404", message: "Chapter tidak ditemukan." });
    }
    res.status(502).render("error", { pageTitle: "Error", message: "Gagal memuat chapter: " + e.message });
  }
});

// ---------- Auth demo (UI only) ----------
app.get("/login", (_req, res) => {
  res.render("login", { pageTitle: "Login" });
});

app.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  const user = users.get(String(email || "").toLowerCase());
  if (!user || user.password !== password) {
    return res.status(401).render("error", {
      pageTitle: "Login Gagal",
      message: "Email atau password salah (demo: register dulu, atau password tidak cocok).",
    });
  }
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { email: user.email, username: user.username });
  res.cookie("sid", token, { httpOnly: true, sameSite: "lax", signed: true, maxAge: 1000 * 60 * 60 * 24 * 3 });
  res.redirect("/");
});

app.get("/register", (_req, res) => {
  res.render("register", { pageTitle: "Register" });
});

app.post("/register", (req, res) => {
  const { username, email, password } = req.body || {};
  const key = String(email || "").toLowerCase();
  if (!username || !email || !password) {
    return res.status(400).render("error", {
      pageTitle: "Register Gagal",
      message: "Semua field wajib diisi.",
    });
  }
  if (users.has(key)) {
    return res.status(400).render("error", {
      pageTitle: "Register Gagal",
      message: "Email sudah terdaftar.",
    });
  }
  users.set(key, { username, email: key, password });
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { email: key, username });
  res.cookie("sid", token, { httpOnly: true, sameSite: "lax", signed: true, maxAge: 1000 * 60 * 60 * 24 * 3 });
  res.redirect("/");
});

app.post("/logout", (req, res) => {
  const token = req.signedCookies?.sid;
  if (token) sessions.delete(token);
  res.clearCookie("sid");
  res.redirect("/");
});

// 404
app.use((req, res) => {
  res.status(404).render("error", { pageTitle: "404", message: "Halaman tidak ditemukan." });
});

app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
