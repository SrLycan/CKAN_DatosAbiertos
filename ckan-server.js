require("dotenv").config();
const express  = require("express");
const axios    = require("axios");
const cors     = require("cors");
const helmet   = require("helmet");
const { createClient } = require("@supabase/supabase-js");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Validar variables de entorno ──────────────────────────────────────────────
const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`❌ Faltan variables de entorno: ${missing.join(", ")}`);
  process.exit(1);
}

const CKAN_BASE       = process.env.CKAN_BASE_URL || "https://datosabiertos.presidencia.gob.ec/api/3/action";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:5173").split(",");

// ── Clientes Supabase ─────────────────────────────────────────────────────────
// service_role: bypasa RLS → operaciones del backend
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// anon: respeta RLS → solo para verificar tokens
const supabaseAnon = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// ── Cache (CKAN) ──────────────────────────────────────────────────────────────
const cache = new Map();
function getCached(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { cache.delete(key); return null; }
  return e.data;
}
function setCache(key, data, ttl = 300) {
  cache.set(key, { data, expiresAt: Date.now() + ttl * 1000 });
}

// ── CKAN client ───────────────────────────────────────────────────────────────
const ckanClient = axios.create({
  baseURL: CKAN_BASE,
  timeout: 12000,
  headers: { "User-Agent": "DatosabiertosEC-Dashboard/2.0" },
});

async function ckan(action, params = {}, ttl = 300) {
  const key    = `${action}:${JSON.stringify(params)}`;
  const cached = ttl > 0 ? getCached(key) : null;
  if (cached) return cached;
  const { data: body } = await ckanClient.get(`/${action}`, { params });
  if (!body.success) throw new Error(`CKAN: ${body.error?.message || body.error?.type || "error"}`);
  if (ttl > 0) setCache(key, body.result, ttl);
  return body.result;
}

// ── Middleware global ─────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: (origin, cb) =>
    (!origin || ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes("*"))
      ? cb(null, true)
      : cb(new Error(`CORS bloqueado: ${origin}`)),
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json({ limit: "50mb" }));
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Auth middleware ───────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token de autenticación requerido" });
  }
  const token = auth.slice(7);
  try {
    const { data: { user }, error } = await supabaseAnon.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Token inválido o expirado" });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Error al verificar autenticación" });
  }
}

// ── Audit log helper ──────────────────────────────────────────────────────────
// FIX: usa supabaseAdmin para insertar (bypasa RLS) y guarda email como TEXT
async function auditLog(userId, userEmail, action, period, filename, ip) {
  try {
    await supabaseAdmin
      .from("admin_audit_log")
      .insert({ user_id: userId, user_email: userEmail, action, period: period || null, filename: filename || null, ip_address: ip || null });
  } catch (err) {
    console.warn("[AUDIT] Error al registrar:", err.message);
  }
}

// ════════════════════════════════════════════════════════════════════════════════
//  RUTAS ADMIN
// ════════════════════════════════════════════════════════════════════════════════

// POST /api/admin/periods — Subir o actualizar un período
app.post("/api/admin/periods", requireAuth, async (req, res) => {
  const { period_label, period_start, period_end, filename, processed_data } = req.body;

  if (!period_label || !period_start || !period_end || !filename || !processed_data) {
    return res.status(400).json({ error: "Faltan campos requeridos" });
  }
  if (!processed_data.entities || !Array.isArray(processed_data.entities)) {
    return res.status(400).json({ error: "processed_data.entities debe ser un array" });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("indicator_periods")
      .upsert(
        {
          period_label,
          period_start,
          period_end,
          filename,
          processed_data,
          uploaded_by:       req.user.id,
          uploaded_by_email: req.user.email,   // ← guardamos email directo, sin JOIN
          updated_at:        new Date().toISOString(),
        },
        { onConflict: "period_label" }
      )
      .select("id, period_label, created_at, updated_at")
      .single();

    if (error) throw error;

    await auditLog(req.user.id, req.user.email, "upload", period_label, filename, req.ip);
    res.json({ success: true, period: data });
  } catch (err) {
    console.error("[SUPABASE] POST periods:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// DELETE /api/admin/periods/:id
app.delete("/api/admin/periods/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const { data: existing } = await supabaseAdmin
      .from("indicator_periods")
      .select("period_label, raw_xlsx_path")
      .eq("id", id)
      .single();

    const { error } = await supabaseAdmin
      .from("indicator_periods")
      .delete()
      .eq("id", id);

    if (error) throw error;

    if (existing?.raw_xlsx_path) {
      await supabaseAdmin.storage
        .from("indicator-files")
        .remove([existing.raw_xlsx_path])
        .catch(e => console.warn("[STORAGE DELETE]", e.message));
    }

    await auditLog(req.user.id, req.user.email, "delete", existing?.period_label, null, req.ip);
    res.json({ success: true });
  } catch (err) {
    console.error("[SUPABASE] DELETE periods:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// GET /api/admin/audit
app.get("/api/admin/audit", requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("admin_audit_log")
    .select("*")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error("[SUPABASE] GET audit:", error.message);
    return res.status(502).json({ error: error.message });
  }
  res.json({ logs: data || [] });
});

// POST /api/cache/clear
app.post("/api/cache/clear", requireAuth, (req, res) => {
  const size = cache.size;
  cache.clear();
  res.json({ cleared: size, message: "Cache vaciada" });
});

// ════════════════════════════════════════════════════════════════════════════════
//  RUTAS PÚBLICAS — PERÍODOS
// ════════════════════════════════════════════════════════════════════════════════

// GET /api/periods — lista ligera (usa la vista, sin auth.users)
app.get("/api/periods", async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("periods_summary")
      .select("*");

    if (error) throw error;
    res.json({ periods: data || [], fetched_at: new Date().toISOString() });
  } catch (err) {
    console.error("[SUPABASE] GET periods:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// GET /api/periods/latest
app.get("/api/periods/latest", async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("indicator_periods")
      .select("id, period_label, period_start, period_end, filename, processed_data, updated_at, uploaded_by_email")
      .order("period_start", { ascending: false })
      .limit(1)
      .single();

    if (error && error.code === "PGRST116") {
      return res.json({ period: null, fetched_at: new Date().toISOString() });
    }
    if (error) throw error;
    res.json({ period: data, fetched_at: new Date().toISOString() });
  } catch (err) {
    console.error("[SUPABASE] GET latest:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// GET /api/periods/:id
app.get("/api/periods/:id", async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("indicator_periods")
      .select("id, period_label, period_start, period_end, filename, processed_data, updated_at, uploaded_by_email")
      .eq("id", req.params.id)
      .single();

    if (error?.code === "PGRST116") return res.status(404).json({ error: "Período no encontrado" });
    if (error) throw error;
    res.json({ period: data, fetched_at: new Date().toISOString() });
  } catch (err) {
    console.error("[SUPABASE] GET period:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
//  HEALTH
// ════════════════════════════════════════════════════════════════════════════════
app.get("/health", (_req, res) => res.json({
  status:     "ok",
  timestamp:  new Date().toISOString(),
  ckan_base:  CKAN_BASE,
  cache_size: cache.size,
  supabase:   !!process.env.SUPABASE_URL,
}));

// ════════════════════════════════════════════════════════════════════════════════
//  RUTAS CKAN
// ════════════════════════════════════════════════════════════════════════════════

app.get("/api/portal/summary", async (_req, res) => {
  try {
    const [pkgResult, orgList, grpList] = await Promise.all([
      ckan("package_search", { rows: 0, facet: "true", "facet.field": JSON.stringify(["res_format"]), "facet.limit": 5 }),
      ckan("organization_list", { all_fields: "true", include_dataset_count: "true" }),
      ckan("group_list",        { all_fields: "true", include_dataset_count: "true" }),
    ]);
    const resourceTotal = await ckan("resource_search", { query: "name:", limit: 0 })
      .then(r => r.count ?? null).catch(() => null);
    res.json({
      datasets:      pkgResult.count ?? 0,
      resources:     resourceTotal,
      organizations: Array.isArray(orgList) ? orgList.length : 0,
      groups:        Array.isArray(grpList) ? grpList.length : 0,
      top_formats:   pkgResult.search_facets?.res_format?.items?.slice(0, 5) ?? [],
      fetched_at:    new Date().toISOString(),
    });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.get("/api/portal/recent", async (req, res) => {
  const rows = Math.min(parseInt(req.query.rows) || 5, 20);
  const sort = req.query.sort || "metadata_modified desc";
  try {
    const result = await ckan("package_search", { rows, sort }, 120);
    const datasets = result.results.map(d => ({
      id:   d.id, name: d.name, title: d.title || d.name,
      url:  `https://datosabiertos.presidencia.gob.ec/dataset/${d.name}`,
      organization: { name: d.organization?.name, title: d.organization?.display_name || d.organization?.title },
      groups:    d.groups?.map(g => g.display_name || g.name) ?? [],
      resources: d.resources?.map(r => ({ id: r.id, name: r.name || r.url?.split("/").pop(), format: r.format || "—", url: r.url, size: r.size })) ?? [],
      num_resources:     d.num_resources || 0,
      metadata_created:  d.metadata_created?.slice(0, 10),
      metadata_modified: d.metadata_modified?.slice(0, 10),
    }));
    res.json({ count: result.count, rows: datasets, fetched_at: new Date().toISOString() });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.get("/api/portal/groups", async (_req, res) => {
  try {
    const groups = await ckan("group_list", { all_fields: "true", include_dataset_count: "true", include_extras: "true", limit: 500 });
    const sorted = (Array.isArray(groups) ? groups : [])
      .filter(g => (g.package_count || 0) > 0)
      .map(g => ({ id: g.id, name: g.name, title: g.display_name || g.title || g.name, count: g.package_count || 0, image_url: g.image_display_url || null }))
      .sort((a, b) => b.count - a.count);
    res.json({ groups: sorted, fetched_at: new Date().toISOString() });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.get("/api/portal/organizations", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 500);
  try {
    const orgs = await ckan("organization_list", { all_fields: "true", include_dataset_count: "true", sort: "package_count desc", limit });
    const result = (Array.isArray(orgs) ? orgs : [])
      .filter(o => (o.package_count || 0) > 0)
      .map(o => ({ id: o.id, name: o.name, title: o.display_name || o.title || o.name, count: o.package_count || 0, url: `https://datosabiertos.presidencia.gob.ec/organization/${o.name}` }));
    res.json({ organizations: result, fetched_at: new Date().toISOString() });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.get("/api/portal/formats", async (_req, res) => {
  try {
    const result = await ckan("package_search", { rows: 0, facet: "true", "facet.field": JSON.stringify(["res_format"]), "facet.limit": 20 });
    res.json({ formats: (result.search_facets?.res_format?.items ?? []).sort((a, b) => b.count - a.count), fetched_at: new Date().toISOString() });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.get("/api/portal/activity", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 30);
  try {
    const activity = await ckan("recently_changed_packages_activity_list", { limit }, 90);
    const result = (Array.isArray(activity) ? activity : []).map(a => ({
      id: a.id, timestamp: a.timestamp?.slice(0, 16), activity_type: a.activity_type,
      package_title: a.data?.package?.title || a.data?.package?.name || "?",
      package_url:   a.data?.package?.name ? `https://datosabiertos.presidencia.gob.ec/dataset/${a.data.package.name}` : null,
    }));
    res.json({ activity: result, fetched_at: new Date().toISOString() });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.get("/api/portal/search", async (req, res) => {
  const { q = "", rows = "10", sort = "metadata_modified desc", fq = "", start = "0" } = req.query;
  try {
    const result = await ckan("package_search", {
      q, rows: Math.min(parseInt(rows), 50), sort, fq, start: parseInt(start),
      facet: "true", "facet.field": JSON.stringify(["organization", "groups", "res_format"]), "facet.limit": 8,
    }, 120);
    res.json({
      total:   result.count,
      results: result.results.map(d => ({
        id: d.id, name: d.name, title: d.title || d.name,
        org: d.organization?.display_name || d.organization?.title || d.organization?.name,
        groups: d.groups?.map(g => g.display_name || g.name) ?? [],
        modified: d.metadata_modified?.slice(0, 10), resources: d.num_resources,
        url:    `https://datosabiertos.presidencia.gob.ec/dataset/${d.name}`,
        format: d.resources?.[0]?.format || "—",
      })),
      facets: result.search_facets ?? {}, fetched_at: new Date().toISOString(),
    });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.get("/api/portal/dataset/:id", async (req, res) => {
  try {
    const dataset = await ckan("package_show", { id: req.params.id }, 600);
    res.json({ dataset, fetched_at: new Date().toISOString() });
  } catch (err) {
    res.status(err.message.includes("Not found") ? 404 : 502).json({ error: err.message });
  }
});

app.get("/api/portal/stats", async (_req, res) => {
  try {
    const [pkgSearch, orgList, grpList, recentPkg, activityList] = await Promise.allSettled([
      ckan("package_search", { rows: 0, facet: "true", "facet.field": JSON.stringify(["res_format", "organization", "groups"]), "facet.limit": 500 }),
      ckan("organization_list", { all_fields: "true", include_dataset_count: "true", sort: "package_count desc", limit: 500 }),
      ckan("group_list",        { all_fields: "true", include_dataset_count: "true", limit: 500 }),
      ckan("package_search", { rows: 5, sort: "metadata_modified desc" }, 120),
      ckan("recently_changed_packages_activity_list", { limit: 8 }, 90),
    ]);
    const pkg    = pkgSearch.status    === "fulfilled" ? pkgSearch.value    : {};
    const orgs   = orgList.status      === "fulfilled" ? orgList.value      : [];
    const groups = grpList.status      === "fulfilled" ? grpList.value      : [];
    const recent = recentPkg.status    === "fulfilled" ? recentPkg.value    : {};
    const acts   = activityList.status === "fulfilled" ? activityList.value : [];

    res.json({
      summary: { datasets: pkg.count ?? 0, organizations: Array.isArray(orgs) ? orgs.length : 0, groups: Array.isArray(groups) ? groups.length : 0 },
      formats:      (pkg.search_facets?.res_format?.items ?? []).sort((a, b) => b.count - a.count).slice(0, 8),
      top_orgs:     (Array.isArray(orgs) ? orgs : []).filter(o => (o.package_count || 0) > 0).map(o => ({ name: o.display_name || o.title || o.name, count: o.package_count || 0 })).sort((a, b) => b.count - a.count),
      groups_chart: (Array.isArray(groups) ? groups : []).filter(g => (g.package_count || 0) > 0).map(g => ({ name: g.display_name || g.title || g.name, slug: g.name, count: g.package_count || 0 })).sort((a, b) => b.count - a.count),
      recent_datasets: (recent.results || []).map(d => ({
        title: d.title || d.name, org: d.organization?.display_name || d.organization?.title || d.organization?.name || "—",
        modified: d.metadata_modified?.slice(0, 10), resources: d.num_resources || 0,
        format: d.resources?.[0]?.format || "—", url: `https://datosabiertos.presidencia.gob.ec/dataset/${d.name}`,
      })),
      recent_activity: (Array.isArray(acts) ? acts : []).slice(0, 8).map(a => ({
        type: a.activity_type, package: a.data?.package?.title || a.data?.package?.name || "?",
        timestamp: a.timestamp?.slice(0, 16),
        url: a.data?.package?.name ? `https://datosabiertos.presidencia.gob.ec/dataset/${a.data.package.name}` : null,
      })),
      fetched_at: new Date().toISOString(),
    });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ── Error handler global ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error("[ERROR]", err.message);
  res.status(500).json({ error: err.message });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  Backend corriendo en http://localhost:${PORT}             ║
╠══════════════════════════════════════════════════════════╣
║  GET    /api/periods             → Lista períodos        ║
║  GET    /api/periods/latest      → Período más reciente  ║
║  GET    /api/periods/:id         → Datos de período      ║
║  POST   /api/admin/periods       → Subir período (auth)  ║
║  DELETE /api/admin/periods/:id   → Eliminar (auth)       ║
║  GET    /api/admin/audit         → Log de acciones       ║
║  GET    /health                  → Estado del servidor   ║
╚══════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;