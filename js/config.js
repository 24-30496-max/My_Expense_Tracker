// Paste your Supabase project values here (Supabase dashboard > Project Settings > API).
// The "anon public" key is MEANT to be public: your data is protected by the security rules in
// supabase/schema.sql, not by hiding this key. NEVER paste the "service_role" key here.
export const cfg = {
  SUPABASE_URL: 'https://ytxnnkwnzflhxozdzgyn.supabase.co/rest/v1',
  SUPABASE_ANON_KEY: 'sb_publishable_Wetg7elpebFNOeUCp6ZiMw_zV3X8GOp',
};

export const isConfigured = () =>
  cfg.SUPABASE_URL.startsWith('https://') && !/YOUR-/.test(cfg.SUPABASE_URL + cfg.SUPABASE_ANON_KEY);
