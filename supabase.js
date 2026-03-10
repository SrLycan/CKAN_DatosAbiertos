// Cliente de Supabase con privilegios de administrador (service_role)
// IMPORTANTE: este cliente bypasa completamente las políticas RLS (Row Level Security)
// → Solo debe usarse en el backend, NUNCA exponerlo al frontend ni al cliente
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,              // URL del proyecto en Supabase
  process.env.SUPABASE_SERVICE_ROLE_KEY, // Clave secreta con acceso total — ¡mantener privada!
  {
    auth: {
      persistSession: false, // No guarda la sesión en memoria entre llamadas (stateless)
    },
  }
);

module.exports = supabase; // Se exporta para usarlo en rutas y middlewares del servidor