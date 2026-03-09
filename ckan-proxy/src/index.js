const CKAN_BASE = "https://datosabiertos.presidencia.gob.ec/api/3/action";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Proxy-Token",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url    = new URL(request.url);
    const action = url.pathname.replace(/^\//, "");

    if (!action) {
      return new Response(JSON.stringify({ error: "No action specified" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const ckanUrl = `${CKAN_BASE}/${action}${url.search}`;

    try {
      const controller = new AbortController();
      const timeoutId  = setTimeout(() => controller.abort(), 25000);

      const response = await fetch(ckanUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept":          "application/json, text/plain, */*",
          "Accept-Language": "es-EC,es;q=0.9,en;q=0.8",
          "Referer":         "https://datosabiertos.presidencia.gob.ec/",
          "Origin":          "https://datosabiertos.presidencia.gob.ec",
          "Cache-Control":   "no-cache",
          "Pragma":          "no-cache",
        },
      });

      clearTimeout(timeoutId);

      const text = await response.text();

      // Siempre devolver 200 para que axios no rechace la respuesta
      return new Response(text, {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });

    } catch (err) {
      const isTimeout = err.name === "AbortError";
      return new Response(
        JSON.stringify({ success: false, error: isTimeout ? "CKAN timeout" : err.message }),
        {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        }
      );
    }
  },
};