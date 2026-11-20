// Configuración pública del frontend (la llave "publishable" es pública por diseño;
// la seguridad la dan las políticas RLS de Supabase y el backend en Cloud Run).
const local = ["localhost", "127.0.0.1"].includes(location.hostname);
export const CONFIG = {
  SUPABASE_URL: "https://ubaxnpleinqeenvkrutk.supabase.co",
  SUPABASE_KEY: "sb_publishable_CII5kZH3vcesCY3BXLDEPg_yHLkuNop",
  API_URL: local ? "http://127.0.0.1:8090" : "https://simb-api-wut4a22mhq-uc.a.run.app",
};
