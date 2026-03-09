const CKAN_BASE = "https://datosabiertos.presidencia.gob.ec/api/3/action";
// v2 — timeout extendido + respuesta como texto para evitar re-parse

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Extraer el action de CKAN desde el path
    // Ej: /package_search → llama a CKAN /package_search
    const action = url.pathname.replace("/", "");

    if (!action) {
      return new Response(JSON.stringify({ error: "No action specified" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Construir URL de CKAN con los mismos query params
    const ckanUrl = `${CKAN_BASE}/${action}${url.search}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);

      const response = await fetch(ckanUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept":          "application/json, text/plain, */*",
          "Accept-Language": "es-EC,es;q=0.9,en;q=0.8",
          "Referer":         "https://datosabiertos.presidencia.gob.ec/",
          "Origin":          "https://datosabiertos.presidencia.gob.ec",
        },
      });

      clearTimeout(timeoutId);

      // Devolver el texto directo sin re-parsear para evitar errores
      const text = await response.text();

      return new Response(text, {
        status: response.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });

    } catch (err) {
      const isTimeout = err.name === "AbortError";
      return new Response(
        JSON.stringify({ error: isTimeout ? "CKAN timeout" : err.message }),
        {
          status: isTimeout ? 504 : 502,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        }
      );
    }
  },
};