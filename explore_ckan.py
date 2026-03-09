"""
═══════════════════════════════════════════════════════════════════════════════
  EXPLORADOR COMPLETO DE API CKAN
  Portal: https://datosabiertos.presidencia.gob.ec
  
  Extrae y muestra TODOS los datos disponibles públicamente:
    - Estadísticas del sitio
    - Conjuntos de datos (datasets) con metadatos
    - Organizaciones / Instituciones
    - Grupos / Temáticas
    - Etiquetas (tags)
    - Recursos y formatos
    - Actividad reciente
    - Licencias
    - Vocabularios de etiquetas
  
  Uso:
    pip install requests
    python explore_ckan.py
    python explore_ckan.py --output resultados.json   # guarda JSON completo
    python explore_ckan.py --summary                  # resumen rápido
═══════════════════════════════════════════════════════════════════════════════
"""

import requests
import json
import argparse
import sys
import time
from datetime import datetime

BASE_URL = "https://datosabiertos.presidencia.gob.ec/api/3/action"

session = requests.Session()
session.headers.update({
    "User-Agent": "CKAN-Explorer/1.0 (datos abiertos ecuador research)",
    "Accept": "application/json",
})

# ─────────────────────────────────────────────────────────────────────────────
def ckan(action: str, params: dict = None, timeout: int = 15) -> dict:
    """Llama a un endpoint CKAN y retorna el resultado o un dict con 'error'."""
    url = f"{BASE_URL}/{action}"
    try:
        r = session.get(url, params=params or {}, timeout=timeout)
        r.raise_for_status()
        data = r.json()
        if data.get("success"):
            return data.get("result", {})
        else:
            return {"error": data.get("error", {}).get("message", "unknown error")}
    except requests.exceptions.ConnectionError:
        return {"error": "No se pudo conectar al servidor"}
    except requests.exceptions.Timeout:
        return {"error": f"Timeout después de {timeout}s"}
    except requests.exceptions.HTTPError as e:
        return {"error": f"HTTP {e.response.status_code}"}
    except Exception as e:
        return {"error": str(e)}


def banner(title: str):
    w = 70
    print(f"\n{'═'*w}")
    print(f"  {title}")
    print(f"{'═'*w}")


def section(title: str):
    print(f"\n  ── {title} {'─'*(60-len(title))}")


def ok(label, value):
    print(f"    {'✓'} {label:<35} {value}")


def warn(label, msg):
    print(f"    {'⚠'} {label:<35} {msg}")


# ─────────────────────────────────────────────────────────────────────────────
# MÓDULOS DE EXTRACCIÓN
# ─────────────────────────────────────────────────────────────────────────────

def fetch_site_statistics():
    banner("1. ESTADÍSTICAS GENERALES DEL SITIO")
    result = ckan("site_statistics")
    if "error" in result:
        # Fallback: obtener count desde package_search
        pkg = ckan("package_search", {"rows": 0})
        org = ckan("organization_list")
        grp = ckan("group_list")
        result = {
            "dataset_count":      pkg.get("count", "N/A") if "error" not in pkg else "N/A",
            "organization_count": len(org) if "error" not in org else "N/A",
            "group_count":        len(grp) if "error" not in grp else "N/A",
        }

    for k, v in result.items():
        ok(k, v)
    return result


def fetch_datasets_summary():
    banner("2. CONJUNTOS DE DATOS — RESUMEN Y RECIENTES")

    # Total + facetas
    search = ckan("package_search", {
        "rows": 0,
        "facet": "true",
        "facet.field": json.dumps(["organization", "groups", "res_format", "license_id", "tags"]),
        "facet.limit": 10,
    })

    total = search.get("count", 0)
    ok("Total de conjuntos de datos", total)

    facets = search.get("search_facets", {})

    # Top formatos
    section("Formatos más usados")
    for item in (facets.get("res_format", {}).get("items", []))[:8]:
        ok(item["name"], f"{item['count']} datasets")

    # Top organizaciones
    section("Top organizaciones por datasets")
    for item in (facets.get("organization", {}).get("items", []))[:8]:
        ok(item["display_name"] or item["name"], f"{item['count']} datasets")

    # Top grupos/temáticas
    section("Top temáticas/grupos")
    for item in (facets.get("groups", {}).get("items", []))[:8]:
        ok(item["display_name"] or item["name"], f"{item['count']} datasets")

    # Datasets más recientes
    section("5 datasets más recientes")
    recent = ckan("package_search", {
        "rows": 5,
        "sort": "metadata_modified desc",
        "include_drafts": "false",
    })
    for ds in recent.get("results", []):
        mod = ds.get("metadata_modified", "")[:10]
        nres = ds.get("num_resources", 0)
        title = (ds.get("title") or ds.get("name", ""))[:55]
        ok(title, f"{nres} recursos | mod: {mod}")

    # Datasets más descargados (si el portal lo soporta)
    section("Búsqueda por popularidad")
    popular = ckan("package_search", {
        "rows": 5,
        "sort": "views_recent desc",
    })
    if "error" not in popular and popular.get("results"):
        for ds in popular.get("results", []):
            title = (ds.get("title") or ds.get("name", ""))[:55]
            views = ds.get("tracking_summary", {}).get("recent", "N/A")
            ok(title, f"views: {views}")
    else:
        warn("views_recent", "El portal no expone métricas de vistas")

    return {"total": total, "facets": facets, "recent": recent.get("results", [])}


def fetch_organizations():
    banner("3. ORGANIZACIONES / INSTITUCIONES")

    orgs = ckan("organization_list", {
        "all_fields": "true",
        "include_dataset_count": "true",
        "include_extras": "true",
        "sort": "package_count desc",
        "limit": 100,
    })

    if "error" in orgs:
        warn("organization_list", orgs["error"])
        return []

    ok("Total de organizaciones", len(orgs))
    section("Top 15 instituciones por cantidad de datasets")
    for org in orgs[:15]:
        name    = (org.get("display_name") or org.get("title") or org.get("name", ""))[:45]
        count   = org.get("package_count", 0)
        created = org.get("created", "")[:10]
        ok(name, f"{count} datasets | creada: {created}")

    return orgs


def fetch_groups():
    banner("4. GRUPOS / TEMÁTICAS")

    groups = ckan("group_list", {
        "all_fields": "true",
        "include_dataset_count": "true",
        "include_extras": "true",
        "limit": 50,
    })

    if "error" in groups:
        warn("group_list", groups["error"])
        return []

    ok("Total de grupos", len(groups))
    section("Todos los grupos con conteo de datasets")
    for g in sorted(groups, key=lambda x: x.get("package_count", 0), reverse=True):
        name  = (g.get("display_name") or g.get("title") or g.get("name", ""))[:45]
        count = g.get("package_count", 0)
        desc  = (g.get("description") or "")[:60]
        ok(name, f"{count} datasets")
        if desc:
            print(f"        {desc}…" if len(desc) == 60 else f"        {desc}")

    return groups


def fetch_tags():
    banner("5. ETIQUETAS (TAGS)")

    tags = ckan("tag_list", {"all_fields": "true"})

    if "error" in tags:
        warn("tag_list", tags["error"])
        return []

    ok("Total de etiquetas", len(tags))

    # Buscar cuáles tienen más datasets
    section("Etiquetas con más datasets (top 15)")
    tag_counts = []
    for tag in tags[:50]:  # limitar para no hacer demasiadas requests
        name = tag.get("name", "")
        res = ckan("package_search", {"fq": f'tags:"{name}"', "rows": 0})
        count = res.get("count", 0) if "error" not in res else 0
        if count > 0:
            tag_counts.append((name, count))

    for name, count in sorted(tag_counts, key=lambda x: x[1], reverse=True)[:15]:
        ok(name, f"{count} datasets")

    return tags


def fetch_resource_formats():
    banner("6. RECURSOS Y FORMATOS")

    # Buscar todos los formatos disponibles
    formats_raw = ckan("package_search", {
        "rows": 0,
        "facet": "true",
        "facet.field": '["res_format"]',
        "facet.limit": 30,
    })

    formats = formats_raw.get("search_facets", {}).get("res_format", {}).get("items", [])
    ok("Tipos de formato distintos", len(formats))
    section("Todos los formatos")
    for f in sorted(formats, key=lambda x: x["count"], reverse=True):
        bar = "█" * min(int(f["count"] / max(formats[0]["count"] if formats else 1, 1) * 20), 20)
        ok(f['name'] or "(sin formato)", f"{f['count']:>5} datasets  {bar}")

    # Total de recursos
    section("Estadísticas de recursos")
    all_res = ckan("resource_search", {"query": "name:", "limit": 0})
    if "error" not in all_res:
        ok("Total de recursos en el portal", all_res.get("count", "N/A"))
    else:
        warn("resource_search", all_res["error"])

    return formats


def fetch_licenses():
    banner("7. LICENCIAS DISPONIBLES")

    licenses = ckan("license_list")
    if "error" in licenses:
        warn("license_list", licenses["error"])
        return []

    ok("Licencias disponibles", len(licenses))
    for lic in licenses:
        ok(lic.get("title", lic.get("id", "?")), lic.get("url", "—"))

    return licenses


def fetch_recent_activity():
    banner("8. ACTIVIDAD RECIENTE DEL PORTAL")

    activity = ckan("recently_changed_packages_activity_list", {"limit": 10})
    if "error" in activity:
        warn("recently_changed_packages_activity_list", activity["error"])
        # Try alternative
        activity = ckan("package_activity_list", {"limit": 10})

    if isinstance(activity, list) and activity:
        ok("Actividades recientes encontradas", len(activity))
        section("Últimas 10 actividades")
        for act in activity[:10]:
            ts    = (act.get("timestamp") or "")[:16]
            atype = act.get("activity_type", "?")
            actor = act.get("user_id", "?")[:20]
            pkg   = act.get("data", {}).get("package", {}).get("title", "?")[:40]
            ok(f"{atype}", f"{pkg} | {ts} | by {actor}")
    else:
        warn("Actividad reciente", "No disponible o vacía")

    return activity if isinstance(activity, list) else []


def fetch_vocabularies():
    banner("9. VOCABULARIOS DE METADATOS")

    vocabs = ckan("vocabulary_list")
    if "error" in vocabs:
        warn("vocabulary_list", vocabs["error"])
        return []

    ok("Vocabularios disponibles", len(vocabs))
    for v in vocabs:
        ok(v.get("name", "?"), f"{len(v.get('tags', []))} tags")

    return vocabs


def fetch_dataset_detail(num_samples: int = 3):
    """Descarga N datasets completos para ver todos los campos disponibles."""
    banner("10. ESTRUCTURA DETALLADA DE UN DATASET (MUESTRA)")

    sample = ckan("package_search", {"rows": num_samples, "sort": "metadata_modified desc"})
    if "error" in sample:
        warn("package_search (detalle)", sample["error"])
        return

    for ds in sample.get("results", [])[:num_samples]:
        section(f"Dataset: {(ds.get('title') or ds.get('name', '?'))[:60]}")
        campos_importantes = [
            "id", "name", "title", "notes", "url", "state", "type",
            "metadata_created", "metadata_modified", "num_resources",
            "num_tags", "license_id", "license_title",
            "organization", "groups", "tags", "resources",
        ]
        for campo in campos_importantes:
            val = ds.get(campo)
            if val is None:
                continue
            if isinstance(val, list):
                if campo == "resources" and val:
                    print(f"      resources ({len(val)} total):")
                    for res in val[:2]:
                        fmt  = res.get("format", "?")
                        name = (res.get("name") or res.get("url", "?"))[:50]
                        size = res.get("size", "?")
                        ok(f"  [{fmt}] {name}", f"size: {size}")
                elif campo == "tags" and val:
                    tags_str = ", ".join(t.get("name","?") for t in val[:6])
                    ok(campo, tags_str)
                elif campo == "groups" and val:
                    grps_str = ", ".join(g.get("display_name") or g.get("name","?") for g in val)
                    ok(campo, grps_str)
            elif isinstance(val, dict):
                if campo == "organization" and val:
                    ok("organization", f"{val.get('display_name') or val.get('name','?')}")
            else:
                display = str(val)[:80]
                ok(campo, display)


# ─────────────────────────────────────────────────────────────────────────────
# RUNNER PRINCIPAL
# ─────────────────────────────────────────────────────────────────────────────

def run_full_exploration(save_json: str = None):
    print(f"""
╔══════════════════════════════════════════════════════════════════════════════╗
║  EXPLORADOR API CKAN — datosabiertos.presidencia.gob.ec                    ║
║  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}                                                    ║
╚══════════════════════════════════════════════════════════════════════════════╝
""")

    results = {}

    results["site_statistics"]  = fetch_site_statistics()
    results["datasets_summary"] = fetch_datasets_summary()
    results["organizations"]    = fetch_organizations()
    results["groups"]           = fetch_groups()
    results["resource_formats"] = fetch_resource_formats()
    results["licenses"]         = fetch_licenses()
    results["recent_activity"]  = fetch_recent_activity()
    results["vocabularies"]     = fetch_vocabularies()
    fetch_dataset_detail(3)

    # Guardar JSON si se pidió
    if save_json:
        # Serializar: convertir listas de objetos a algo guardable
        def clean(obj):
            if isinstance(obj, dict):
                return {k: clean(v) for k, v in obj.items()}
            elif isinstance(obj, list):
                return [clean(i) for i in obj]
            else:
                return obj

        with open(save_json, "w", encoding="utf-8") as f:
            json.dump(clean(results), f, ensure_ascii=False, indent=2)
        print(f"\n  ✓ Resultados guardados en: {save_json}")

    banner("RESUMEN FINAL — ENDPOINTS DISPONIBLES Y SU USO")
    endpoints = [
        ("site_statistics",                         "Totales globales del portal"),
        ("package_search?rows=0&facet=...",         "Conteos y facetas (formato, org, grupos)"),
        ("package_search?rows=N&sort=modified desc","N datasets más recientes"),
        ("package_search?rows=N&sort=views_recent", "Más visitados (si está habilitado)"),
        ("package_show?id=<id>",                    "Detalle completo de un dataset"),
        ("organization_list?all_fields=true",       "Lista completa de instituciones"),
        ("organization_show?id=<id>",               "Detalle de una institución"),
        ("group_list?all_fields=true",              "Grupos/temáticas con conteos"),
        ("group_show?id=<id>",                      "Detalle de un grupo"),
        ("tag_list?all_fields=true",                "Todas las etiquetas"),
        ("resource_search?query=name:",             "Búsqueda de recursos"),
        ("resource_show?id=<id>",                   "Detalle de un recurso"),
        ("license_list",                            "Licencias disponibles"),
        ("recently_changed_packages_activity_list", "Actividad reciente del portal"),
        ("vocabulary_list",                         "Vocabularios de metadatos"),
        ("user_list",                               "Usuarios (solo admins)"),
        ("status_show",                             "Estado/versión de la instancia CKAN"),
    ]

    for endpoint, desc in endpoints:
        ok(endpoint, desc)

    print(f"""
  ─────────────────────────────────────────────────────────────────────────────
  RECOMENDACIÓN PARA EL BACKEND:
  Los 6 endpoints más útiles para el dashboard son:
  
    1. package_search?rows=5&sort=metadata_modified+desc   → Últimas publicaciones
    2. package_search?rows=0&facet=true&facet.field=...    → Totales y distribución
    3. organization_list?all_fields=true&sort=pkg_count    → Top instituciones
    4. group_list?all_fields=true                          → Datasets por temática
    5. recently_changed_packages_activity_list             → Feed de actividad
    6. resource_search?query=name:&limit=0                 → Total de recursos
  ─────────────────────────────────────────────────────────────────────────────
""")


def run_summary():
    """Solo imprime los números más importantes."""
    print("\n  Consultando portal...\n")
    stats    = ckan("site_statistics")
    total    = ckan("package_search", {"rows": 0})
    orgs     = ckan("organization_list", {"all_fields": "true"})
    groups   = ckan("group_list", {"all_fields": "true"})
    formats  = ckan("package_search", {
        "rows": 0, "facet": "true",
        "facet.field": '["res_format"]', "facet.limit": 5
    })

    print("  ┌────────────────────────────────────────────┐")
    print("  │ RESUMEN RÁPIDO — Portal Datos Abiertos EC  │")
    print("  ├────────────────────────────────────────────┤")
    print(f"  │ Datasets totales:     {str(total.get('count','N/A')):>8}              │")
    print(f"  │ Organizaciones:       {str(len(orgs) if isinstance(orgs, list) else 'N/A'):>8}              │")
    print(f"  │ Grupos/Temáticas:     {str(len(groups) if isinstance(groups, list) else 'N/A'):>8}              │")
    print("  └────────────────────────────────────────────┘")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Explorador API CKAN — datosabiertos.presidencia.gob.ec")
    parser.add_argument("--output",  "-o", metavar="FILE", help="Guardar resultados en JSON")
    parser.add_argument("--summary", "-s", action="store_true", help="Solo resumen rápido")
    args = parser.parse_args()

    if args.summary:
        run_summary()
    else:
        run_full_exploration(save_json=args.output)
