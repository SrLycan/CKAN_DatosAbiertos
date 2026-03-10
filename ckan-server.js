// ─────────────────────────────────────────────────────────────────────────────
//  CKAN-SERVER.JS  — Backend principal del dashboard de Datos Abiertos Ecuador
//  Stack: Node.js · Express · Axios · Supabase · express-rate-limit
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config(); // Carga las variables de entorno desde el archivo .env
const express      = require("express");
const axios        = require("axios");
const cors         = require("cors");
const helmet       = require("helmet");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");

const app  = express();
const PORT = process.env.PORT || 3001; // Puerto configurable por .env, por defecto 3001

// ── Validación de variables de entorno ───────────────────────────────────────
// Si alguna variable crítica falta, el servidor no debe arrancar
const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`❌ Faltan variables de entorno: ${missing.join(", ")}`);
  process.exit(1); // Termina el proceso con código de error
}

// URL base de la API CKAN del portal de datos abiertos de Ecuador
const CKAN_BASE = process.env.CKAN_BASE_URL || "https://datosabiertos.presidencia.gob.ec/api/3/action";

// Orígenes permitidos para CORS (separados por coma en .env)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:5173").split(",");

// ── Clientes Supabase ─────────────────────────────────────────────────────────
// Cliente ADMIN: usa la service_role_key → acceso total sin restricciones RLS
// Solo se usa en el backend, NUNCA se expone al frontend
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// Cliente ANON: usa la anon_key → respeta las políticas RLS de Supabase
// Se usa únicamente para verificar tokens JWT de usuarios autenticados
const supabaseAnon = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// ── Cache en memoria (para respuestas CKAN) ───────────────────────────────────
// Map simple de clave → { data, expiresAt }. Evita llamadas redundantes a CKAN.
const cache = new Map();

// Devuelve el valor cacheado si existe y no ha expirado; si expiró lo elimina
function getCached(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { cache.delete(key); return null; }
  return e.data;
}

// Guarda un valor en cache con TTL en segundos (por defecto 300 s = 5 min)
function setCache(key, data, ttl = 300) {
  cache.set(key, { data, expiresAt: Date.now() + ttl * 1000 });
}

// ── Cliente Axios para la API CKAN ────────────────────────────────────────────
const ckanClient = axios.create({
  baseURL: CKAN_BASE,
  timeout: 12000, // 12 segundos máximo de espera por respuesta
  headers: { "User-Agent": "DatosabiertosEC-Dashboard/2.0" },
});

// Función auxiliar: llama a una acción CKAN con cache opcional
// action  → nombre del endpoint CKAN (ej. "package_search")
// params  → parámetros de query string
// ttl     → segundos que se guarda en cache (0 = no cachear)
async function ckan(action, params = {}, ttl = 300) {
  const key    = `${action}:${JSON.stringify(params)}`; // Clave única por acción + parámetros
  const cached = ttl > 0 ? getCached(key) : null;
  if (cached) return cached; // Retorno rápido si hay cache válida

  const { data: body } = await ckanClient.get(`/${action}`, { params });

  // La API CKAN devuelve { success: true|false, result: ... }
  if (!body.success) throw new Error(`CKAN: ${body.error?.message || body.error?.type || "error"}`);

  if (ttl > 0) setCache(key, body.result, ttl);
  return body.result;
}

// ════════════════════════════════════════════════════════════════════════════════
//  RATE LIMITERS — Protección por IP contra abuso y DDoS
//  Ventana común de 15 minutos. Cada ruta tiene su propio umbral.
// ════════════════════════════════════════════════════════════════════════════════

// Helper: respuesta estándar cuando se supera el límite
function retryAfterMessage(windowMs) {
  return (_req, res) => {
    const retryAfter = Math.ceil(windowMs / 1000 / 60); // Convierte ms → minutos
    res.status(429).json({
      error:       "Demasiadas solicitudes",
      message:     `Has superado el límite de peticiones. Intenta de nuevo en ${retryAfter} minutos.`,
      retry_after: `${retryAfter} minutos`,
    });
  };
}

const WINDOW_MS = 15 * 60 * 1000; // 15 minutos en milisegundos

// 1. LIMITADOR GLOBAL — aplica a todas las rutas (primera barrera de defensa)
//    500 req / IP / 15 min. Excluye /health para que los monitores no se bloqueen.
const globalLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max:      500,
  standardHeaders: true,  // Envía cabeceras RateLimit-* al cliente
  legacyHeaders:   false, // No envía el antiguo X-RateLimit-*
  handler: retryAfterMessage(WINDOW_MS),
  skip: (req) => req.path === "/health", // El health check nunca se limita
});

// 2. LIMITADOR CKAN — exclusivo para /api/portal/*
//    200 req / IP / 15 min (~13 req/min). Protege la API externa de CKAN.
const ckanLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max:      200,
  standardHeaders: true,
  legacyHeaders:   false,
  handler: retryAfterMessage(WINDOW_MS),
  // Respeta la IP real del cliente aunque pase por un proxy/load balancer
  keyGenerator: (req) => {
    const forwarded = req.headers["x-forwarded-for"]?.split(",")[0].trim();
    return ipKeyGenerator(forwarded || req.ip);
  },
});

// 3. LIMITADOR ADMIN — rutas protegidas por autenticación
//    100 req / IP / 15 min. Son usuarios reales con sesión activa.
const adminLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max:      100,
  standardHeaders: true,
  legacyHeaders:   false,
  handler: retryAfterMessage(WINDOW_MS),
});

// 4. LIMITADOR ESTRICTO — endpoints muy sensibles (ej. limpiar cache)
//    Solo 10 req / IP / 15 min. Mínima superficie de ataque.
const strictLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max:      10,
  standardHeaders: true,
  legacyHeaders:   false,
  handler: retryAfterMessage(WINDOW_MS),
});

// ── Middleware global ─────────────────────────────────────────────────────────

// Helmet añade cabeceras de seguridad HTTP (XSS, clickjacking, etc.)
// Se desactiva CSP porque el dashboard gestiona sus propias políticas
app.use(helmet({ contentSecurityPolicy: false }));

// Necesario para que Express lea la IP real cuando hay un proxy delante (ej. Nginx, Heroku)
app.set("trust proxy", 1);

// Aplica el limitador global a TODAS las rutas antes de cualquier otra lógica
app.use(globalLimiter);

// Configura CORS: solo permite peticiones desde los orígenes declarados en .env
app.use(cors({
  origin: (origin, cb) =>
    (!origin || ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes("*"))
      ? cb(null, true)
      : cb(new Error(`CORS bloqueado: ${origin}`)),
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// Parsea cuerpos JSON con límite de 50 MB (para uploads de archivos procesados)
app.use(express.json({ limit: "50mb" }));

// Logger mínimo: registra método, ruta y timestamp de cada petición
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Middleware de autenticación ───────────────────────────────────────────────
// Verifica el JWT de Supabase enviado en el header Authorization: Bearer <token>
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token de autenticación requerido" });
  }
  const token = auth.slice(7); // Extrae el token quitando "Bearer "
  try {
    // supabaseAnon.auth.getUser valida el JWT contra Supabase Auth
    const { data: { user }, error } = await supabaseAnon.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Token inválido o expirado" });
    req.user = user; // Adjunta el usuario al request para uso posterior
    next();
  } catch {
    res.status(401).json({ error: "Error al verificar autenticación" });
  }
}

// ── Registro de auditoría ─────────────────────────────────────────────────────
// Inserta una entrada en admin_audit_log para trazabilidad de acciones sensibles
async function auditLog(userId, userEmail, action, period, filename, ip) {
  try {
    await supabaseAdmin
      .from("admin_audit_log")
      .insert({
        user_id:    userId,
        user_email: userEmail,
        action,                     // "upload" | "delete" | etc.
        period:     period || null,
        filename:   filename || null,
        ip_address: ip || null,
      });
  } catch (err) {
    // No se lanza el error: el log de auditoría nunca debe interrumpir la operación principal
    console.warn("[AUDIT] Error al registrar:", err.message);
  }
}

// ════════════════════════════════════════════════════════════════════════════════
//  RUTAS ADMIN  (requieren autenticación + adminLimiter)
// ════════════════════════════════════════════════════════════════════════════════

// POST /api/admin/periods
// Crea o actualiza un período con sus datos de indicadores procesados
// El upsert usa period_label como clave de conflicto → actualiza si ya existe
app.post("/api/admin/periods", adminLimiter, requireAuth, async (req, res) => {
  const { period_label, period_start, period_end, filename, processed_data } = req.body;

  // Validación básica de campos obligatorios
  if (!period_label || !period_start || !period_end || !filename || !processed_data) {
    return res.status(400).json({ error: "Faltan campos requeridos" });
  }
  // processed_data.entities debe ser un array para que el dashboard pueda iterarlo
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
          uploaded_by:       req.user.id,    // ID del usuario autenticado
          uploaded_by_email: req.user.email,
          updated_at:        new Date().toISOString(),
        },
        { onConflict: "period_label" } // Si el label ya existe → actualiza en lugar de duplicar
      )
      .select("id, period_label, created_at, updated_at")
      .single();

    if (error) throw error;

    // Registra la acción en el log de auditoría
    await auditLog(req.user.id, req.user.email, "upload", period_label, filename, req.ip);
    res.json({ success: true, period: data });
  } catch (err) {
    console.error("[SUPABASE] POST periods:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// DELETE /api/admin/periods/:id
// Elimina un período por ID y también borra su archivo XLSX del storage si existe
app.delete("/api/admin/periods/:id", adminLimiter, requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    // Primero obtenemos el registro para poder auditar el label y limpiar el storage
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

    // Si había un archivo físico en Supabase Storage, lo eliminamos también
    if (existing?.raw_xlsx_path) {
      await supabaseAdmin.storage
        .from("indicator-files")
        .remove([existing.raw_xlsx_path])
        .catch(e => console.warn("[STORAGE DELETE]", e.message)); // Error no crítico
    }

    await auditLog(req.user.id, req.user.email, "delete", existing?.period_label, null, req.ip);
    res.json({ success: true });
  } catch (err) {
    console.error("[SUPABASE] DELETE periods:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// GET /api/admin/audit
// Devuelve las últimas 50 acciones del usuario autenticado (solo ve las suyas)
app.get("/api/admin/audit", adminLimiter, requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("admin_audit_log")
    .select("*")
    .eq("user_id", req.user.id) // Filtro por usuario → cada admin solo ve su historial
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error("[SUPABASE] GET audit:", error.message);
    return res.status(502).json({ error: error.message });
  }
  res.json({ logs: data || [] });
});

// POST /api/cache/clear
// Vacía toda la cache en memoria. Solo 10 usos / 15 min (strictLimiter)
app.post("/api/cache/clear", strictLimiter, requireAuth, (req, res) => {
  const size = cache.size; // Cantidad de entradas antes de limpiar
  cache.clear();
  res.json({ cleared: size, message: "Cache vaciada" });
});

// ════════════════════════════════════════════════════════════════════════════════
//  RUTAS PÚBLICAS — PERÍODOS (sin autenticación, lectura libre)
// ════════════════════════════════════════════════════════════════════════════════

// GET /api/periods
// Lista todos los períodos usando la vista "periods_summary" (sin processed_data pesado)
app.get("/api/periods", async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("periods_summary") // Vista SQL que omite el campo JSONB grande
      .select("*");

    if (error) throw error;
    res.json({ periods: data || [], fetched_at: new Date().toISOString() });
  } catch (err) {
    console.error("[SUPABASE] GET periods:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// GET /api/periods/latest
// Retorna el período más reciente (mayor period_start) con todos sus datos
// Si no hay períodos, devuelve { period: null } sin error
app.get("/api/periods/latest", async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("indicator_periods")
      .select("id, period_label, period_start, period_end, filename, processed_data, updated_at, uploaded_by_email")
      .order("period_start", { ascending: false })
      .limit(1)
      .single(); // Falla con PGRST116 si no hay filas

    // PGRST116 = "no rows" → respuesta vacía controlada, no un error real
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
// Retorna un período específico por su UUID de Supabase
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
//  HEALTH CHECK
// ════════════════════════════════════════════════════════════════════════════════

// GET /health — usado por monitores (UptimeRobot, Railway, etc.)
// Exento del globalLimiter. Responde siempre con el estado actual del servidor.
app.get("/health", (_req, res) => res.json({
  status:     "ok",
  timestamp:  new Date().toISOString(),
  ckan_base:  CKAN_BASE,
  cache_size: cache.size,   // Número de entradas actuales en cache
  supabase:   !!process.env.SUPABASE_URL, // true/false para confirmar configuración
}));

// ════════════════════════════════════════════════════════════════════════════════
//  RUTAS CKAN — Proxy hacia datosabiertos.presidencia.gob.ec
//  Todas aplican ckanLimiter (200 req / IP / 15 min)
// ════════════════════════════════════════════════════════════════════════════════

// GET /api/portal/summary
// Resumen general del portal: total de datasets, recursos, organizaciones y grupos
// También incluye los 5 formatos de archivo más usados
app.get("/api/portal/summary", ckanLimiter, async (_req, res) => {
  try {
    // Llamadas en paralelo para minimizar latencia total
    const [pkgResult, orgList, grpList] = await Promise.all([
      ckan("package_search", { rows: 0, facet: "true", "facet.field": JSON.stringify(["res_format"]), "facet.limit": 5 }),
      ckan("organization_list", { all_fields: "true", include_dataset_count: "true" }),
      ckan("group_list",        { all_fields: "true", include_dataset_count: "true" }),
    ]);
    // resource_search se hace aparte porque puede fallar sin romper el resto
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

// GET /api/portal/recent?rows=5&sort=metadata_modified+desc
// Datasets más recientes. rows máximo: 20. Cachea 2 minutos (120 s).
app.get("/api/portal/recent", ckanLimiter, async (req, res) => {
  const rows = Math.min(parseInt(req.query.rows) || 5, 20); // Límite de seguridad
  const sort = req.query.sort || "metadata_modified desc";
  try {
    const result = await ckan("package_search", { rows, sort }, 120);
    const datasets = result.results.map(d => ({
      id:   d.id, name: d.name, title: d.title || d.name,
      url:  `https://datosabiertos.presidencia.gob.ec/dataset/${d.name}`,
      organization: { name: d.organization?.name, title: d.organization?.display_name || d.organization?.title },
      groups:    d.groups?.map(g => g.display_name || g.name) ?? [],
      // Normaliza cada recurso para que el frontend reciba una estructura uniforme
      resources: d.resources?.map(r => ({
        id: r.id, name: r.name || r.url?.split("/").pop(),
        format: r.format || "—", url: r.url, size: r.size,
      })) ?? [],
      num_resources:     d.num_resources || 0,
      metadata_created:  d.metadata_created?.slice(0, 10),  // Solo la fecha (YYYY-MM-DD)
      metadata_modified: d.metadata_modified?.slice(0, 10),
    }));
    res.json({ count: result.count, rows: datasets, fetched_at: new Date().toISOString() });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// GET /api/portal/groups
// Lista de grupos con datasets, filtrados a solo los que tienen al menos 1 dataset
// Ordenados de mayor a menor cantidad de datasets
app.get("/api/portal/groups", ckanLimiter, async (_req, res) => {
  try {
    const groups = await ckan("group_list", {
      all_fields: "true", include_dataset_count: "true",
      include_extras: "true", limit: 500,
    });
    const sorted = (Array.isArray(groups) ? groups : [])
      .filter(g => (g.package_count || 0) > 0)
      .map(g => ({
        id: g.id, name: g.name,
        title:     g.display_name || g.title || g.name,
        count:     g.package_count || 0,
        image_url: g.image_display_url || null,
      }))
      .sort((a, b) => b.count - a.count); // Descendente por número de datasets
    res.json({ groups: sorted, fetched_at: new Date().toISOString() });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// GET /api/portal/organizations?limit=20
// Lista de organizaciones con al menos 1 dataset. límite máximo 500.
app.get("/api/portal/organizations", ckanLimiter, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 500);
  try {
    const orgs = await ckan("organization_list", {
      all_fields: "true", include_dataset_count: "true",
      sort: "package_count desc", limit,
    });
    const result = (Array.isArray(orgs) ? orgs : [])
      .filter(o => (o.package_count || 0) > 0)
      .map(o => ({
        id: o.id, name: o.name,
        title: o.display_name || o.title || o.name,
        count: o.package_count || 0,
        url:   `https://datosabiertos.presidencia.gob.ec/organization/${o.name}`,
      }));
    res.json({ organizations: result, fetched_at: new Date().toISOString() });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// GET /api/portal/formats
// Distribución de formatos de archivo (CSV, XLSX, PDF, etc.) de todos los recursos
// Hasta 20 formatos, ordenados de mayor a menor frecuencia
app.get("/api/portal/formats", ckanLimiter, async (_req, res) => {
  try {
    const result = await ckan("package_search", {
      rows: 0, facet: "true",
      "facet.field": JSON.stringify(["res_format"]),
      "facet.limit": 20,
    });
    res.json({
      formats: (result.search_facets?.res_format?.items ?? [])
        .sort((a, b) => b.count - a.count),
      fetched_at: new Date().toISOString(),
    });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// GET /api/portal/activity?limit=10
// Actividad reciente del portal: datasets creados/actualizados
// Cachea 120 segundos (cambia frecuentemente). Límite máximo: 30 entradas.
app.get("/api/portal/activity", ckanLimiter, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 30);
  try {
    const activity = await ckan("recently_changed_packages_activity_list", { limit }, 120);
    const result = (Array.isArray(activity) ? activity : []).map(a => ({
      id:            a.id,
      timestamp:     a.timestamp?.slice(0, 16), // Recorta a "YYYY-MM-DDTHH:MM"
      activity_type: a.activity_type,           // "new package", "changed package", etc.
      package_title: a.data?.package?.title || a.data?.package?.name || "?",
      package_url:   a.data?.package?.name
        ? `https://datosabiertos.presidencia.gob.ec/dataset/${a.data.package.name}`
        : null,
    }));
    res.json({ activity: result, fetched_at: new Date().toISOString() });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// GET /api/portal/search?q=&rows=10&sort=&fq=&start=0
// Búsqueda de datasets con paginación y facetas (organización, grupo, formato)
// Límite de 50 resultados por petición para proteger la API CKAN
app.get("/api/portal/search", ckanLimiter, async (req, res) => {
  const { q = "", rows = "10", sort = "metadata_modified desc", fq = "", start = "0" } = req.query;
  try {
    const result = await ckan("package_search", {
      q,
      rows:  Math.min(parseInt(rows), 50),
      sort, fq,
      start: parseInt(start),
      facet: "true",
      "facet.field": JSON.stringify(["organization", "groups", "res_format"]),
      "facet.limit": 8, // Máximo 8 valores por faceta
    }, 120);
    res.json({
      total:   result.count,
      results: result.results.map(d => ({
        id: d.id, name: d.name, title: d.title || d.name,
        org:      d.organization?.display_name || d.organization?.title || d.organization?.name,
        groups:   d.groups?.map(g => g.display_name || g.name) ?? [],
        modified: d.metadata_modified?.slice(0, 10),
        resources: d.num_resources,
        url:    `https://datosabiertos.presidencia.gob.ec/dataset/${d.name}`,
        format: d.resources?.[0]?.format || "—", // Formato del primer recurso como referencia
      })),
      facets:     result.search_facets ?? {},
      fetched_at: new Date().toISOString(),
    });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// GET /api/portal/dataset/:id
// Datos completos de un dataset individual (por nombre o UUID de CKAN)
// Cachea 10 minutos (600 s) porque los datasets individuales cambian poco
app.get("/api/portal/dataset/:id", ckanLimiter, async (req, res) => {
  try {
    const dataset = await ckan("package_show", { id: req.params.id }, 600);
    res.json({ dataset, fetched_at: new Date().toISOString() });
  } catch (err) {
    // CKAN devuelve "Not found" en el mensaje cuando el dataset no existe
    res.status(err.message.includes("Not found") ? 404 : 502).json({ error: err.message });
  }
});

// GET /api/portal/stats
// Agregado completo para el dashboard principal: resumen, formatos, organizaciones,
// grupos, datasets recientes y actividad reciente. Se obtiene todo en paralelo.
// Promise.allSettled garantiza que un fallo parcial no rompa toda la respuesta.
app.get("/api/portal/stats", ckanLimiter, async (_req, res) => {
  try {
    const [pkgSearch, orgList, grpList, recentPkg, activityList] = await Promise.allSettled([
      ckan("package_search", { rows: 0, facet: "true", "facet.field": JSON.stringify(["res_format", "organization", "groups"]), "facet.limit": 500 }),
      ckan("organization_list", { all_fields: "true", include_dataset_count: "true", sort: "package_count desc", limit: 500 }),
      ckan("group_list",        { all_fields: "true", include_dataset_count: "true", limit: 500 }),
      ckan("package_search",   { rows: 5, sort: "metadata_modified desc" }, 120),
      ckan("recently_changed_packages_activity_list", { limit: 8 }, 90),
    ]);

    // Extrae el valor de cada promesa o un fallback vacío si falló
    const pkg    = pkgSearch.status    === "fulfilled" ? pkgSearch.value    : {};
    const orgs   = orgList.status      === "fulfilled" ? orgList.value      : [];
    const groups = grpList.status      === "fulfilled" ? grpList.value      : [];
    const recent = recentPkg.status    === "fulfilled" ? recentPkg.value    : {};
    const acts   = activityList.status === "fulfilled" ? activityList.value : [];

    res.json({
      summary: {
        datasets:      pkg.count ?? 0,
        organizations: Array.isArray(orgs) ? orgs.length : 0,
        groups:        Array.isArray(groups) ? groups.length : 0,
      },
      // Top 8 formatos de archivo ordenados por frecuencia
      formats: (pkg.search_facets?.res_format?.items ?? [])
        .sort((a, b) => b.count - a.count).slice(0, 8),
      // Organizaciones con al menos 1 dataset, ordenadas por volumen
      top_orgs: (Array.isArray(orgs) ? orgs : [])
        .filter(o => (o.package_count || 0) > 0)
        .map(o => ({ name: o.display_name || o.title || o.name, count: o.package_count || 0 }))
        .sort((a, b) => b.count - a.count),
      // Grupos para gráfico, incluye slug para enlace al portal
      groups_chart: (Array.isArray(groups) ? groups : [])
        .filter(g => (g.package_count || 0) > 0)
        .map(g => ({ name: g.display_name || g.title || g.name, slug: g.name, count: g.package_count || 0 }))
        .sort((a, b) => b.count - a.count),
      // 5 datasets más recientemente modificados
      recent_datasets: (recent.results || []).map(d => ({
        title:     d.title || d.name,
        org:       d.organization?.display_name || d.organization?.title || d.organization?.name || "—",
        modified:  d.metadata_modified?.slice(0, 10),
        resources: d.num_resources || 0,
        format:    d.resources?.[0]?.format || "—",
        url:       `https://datosabiertos.presidencia.gob.ec/dataset/${d.name}`,
      })),
      // Últimas 8 actividades del portal
      recent_activity: (Array.isArray(acts) ? acts : []).slice(0, 8).map(a => ({
        type:      a.activity_type,
        package:   a.data?.package?.title || a.data?.package?.name || "?",
        timestamp: a.timestamp?.slice(0, 16),
        url: a.data?.package?.name
          ? `https://datosabiertos.presidencia.gob.ec/dataset/${a.data.package.name}`
          : null,
      })),
      fetched_at: new Date().toISOString(),
    });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ── Manejador global de errores ───────────────────────────────────────────────
// Captura cualquier error no manejado en los middlewares o rutas
app.use((err, _req, res, _next) => {
  console.error("[ERROR]", err.message);
  res.status(500).json({ error: err.message });
});

// ── Inicio del servidor ───────────────────────────────────────────────────────
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
╠══════════════════════════════════════════════════════════╣
║  CKAN  /api/portal/*                                    ║
║  GET   /api/portal/summary       → Resumen general      ║
║  GET   /api/portal/recent        → Datasets recientes   ║
║  GET   /api/portal/groups        → Grupos               ║
║  GET   /api/portal/organizations → Organizaciones       ║
║  GET   /api/portal/formats       → Formatos             ║
║  GET   /api/portal/activity      → Actividad reciente   ║
║  GET   /api/portal/search        → Búsqueda             ║
║  GET   /api/portal/dataset/:id   → Dataset por ID       ║
║  GET   /api/portal/stats         → Estadísticas         ║
╠══════════════════════════════════════════════════════════╣
║  RATE LIMITS (por IP / 15 min)                          ║
║  Global:       500 req  → todo el servidor              ║
║  CKAN:         200 req  → /api/portal/*                 ║
║  Admin:        100 req  → /api/admin/*                  ║
║  Strict:        10 req  → /api/cache/clear              ║
╚══════════════════════════════════════════════════════════╝
  `);
});
// Exporta la app para tests con Jest/Supertest
module.exports = app;