# CKAN Backend — datosabiertos.presidencia.gob.ec

Proxy backend Node.js/Express que resuelve el bloqueo CORS del portal
y expone endpoints limpios para el dashboard de indicadores.

---

## Instalación rápida

```bash
cd ckan-backend
npm install

# Copiar y editar variables de entorno
cp .env.example .env

# Arrancar en desarrollo (con hot-reload)
npm run dev

# Producción
npm start
```

El servidor levanta en **http://localhost:3001**

---

## Endpoints disponibles

| Endpoint | TTL cache | Descripción |
|---|---|---|
| `GET /health` | — | Estado del servidor |
| `GET /api/portal/stats` | 5 min | **Todo junto** para el dashboard (1 llamada) |
| `GET /api/portal/summary` | 5 min | Totales: datasets, orgs, recursos, grupos |
| `GET /api/portal/recent?rows=5` | 2 min | Últimas N publicaciones |
| `GET /api/portal/groups` | 5 min | Datasets por temática/grupo |
| `GET /api/portal/organizations?limit=20` | 5 min | Top instituciones por datasets |
| `GET /api/portal/formats` | 5 min | Distribución de formatos (CSV, JSON…) |
| `GET /api/portal/activity?limit=10` | 90 seg | Feed de actividad reciente |
| `GET /api/portal/tags?limit=30` | 5 min | Etiquetas más usadas |
| `GET /api/portal/search?q=salud&rows=10` | 1 min | Búsqueda libre |
| `GET /api/portal/dataset/:id` | 10 min | Detalle completo de un dataset |

---

## Ejemplo de respuesta — `/api/portal/stats`

```json
{
  "summary": {
    "datasets": 1535,
    "organizations": 98,
    "groups": 14
  },
  "formats": [
    { "name": "CSV",  "count": 620 },
    { "name": "XLSX", "count": 310 },
    { "name": "JSON", "count": 205 }
  ],
  "top_orgs": [
    { "name": "Ministerio de Finanzas", "count": 142 },
    { "name": "INEC", "count": 118 }
  ],
  "groups_chart": [
    { "name": "Economía y Finanzas", "count": 210 }
  ],
  "recent_datasets": [
    {
      "title": "Presupuesto General del Estado 2024",
      "org": "Ministerio de Finanzas",
      "modified": "2024-11-15",
      "resources": 3,
      "format": "CSV",
      "url": "https://datosabiertos.presidencia.gob.ec/dataset/..."
    }
  ],
  "recent_activity": [...],
  "fetched_at": "2024-11-20T14:30:00.000Z"
}
```

---

## Explorador Python

Para descubrir todos los datos disponibles antes de implementar:

```bash
pip install requests

# Exploración completa (imprime todo en consola)
python explore_ckan.py

# Guardar resultados en JSON
python explore_ckan.py --output resultados.json

# Solo resumen rápido
python explore_ckan.py --summary
```

---

## Integración con el dashboard React

En el componente `useCKANData` del dashboard, cambia la URL del proxy:

```javascript
// Antes (corsproxy.io — poco confiable):
const PROXY = "https://corsproxy.io/?";
const ckanURL = (path) => PROXY + encodeURIComponent(PORTAL_URL + path);

// Después (tu backend — confiable):
const BACKEND = process.env.REACT_APP_BACKEND_URL || "http://localhost:3001";

// Una sola llamada que devuelve todo:
const response = await fetch(`${BACKEND}/api/portal/stats`);
const data = await response.json();
```

---

## Deploy en producción

### Opción A — Railway / Render (recomendado, gratis)
```bash
# Railway:
npm install -g @railway/cli
railway login
railway init
railway up
```

### Opción B — VPS con PM2
```bash
npm install -g pm2
pm2 start server.js --name ckan-backend
pm2 save && pm2 startup
```

### Opción C — Docker
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3001
CMD ["node", "server.js"]
```

---

## Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `3001` | Puerto del servidor |
| `CKAN_BASE_URL` | URL del portal | Base URL de la API CKAN |
| `ALLOWED_ORIGINS` | localhost | Orígenes CORS permitidos |
| `ADMIN_TOKEN` | — | Token para `/api/cache/clear` |
