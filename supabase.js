const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY, // service_role bypasa RLS
  { auth: { persistSession: false } }
);

module.exports = supabase;