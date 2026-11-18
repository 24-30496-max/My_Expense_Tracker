// Paste your Supabase project values here (Supabase dashboard > Project Settings > API).
// The "anon public" key is MEANT to be public: your data is protected by the security rules in
// supabase/schema.sql, not by hiding this key. NEVER paste the "service_role" key here.
export const cfg = {
  SUPABASE_URL: 'https://ytxnnkwnzflhxozdzgyn.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_Wetg7elpebFNOeUCp6ZiMw_zV3X8GOp',
};

// Accepts the URL however it was pasted: strips spaces, a trailing "/", or extra paths like "/rest/v1".
export const supabaseUrl = () => {
  try { return new URL(cfg.SUPABASE_URL.trim()).origin; } catch { return ''; }
};
export const supabaseKey = () => cfg.SUPABASE_ANON_KEY.trim();

export const isConfigured = () =>
  supabaseUrl().startsWith('https://') && !/YOUR-/.test(cfg.SUPABASE_URL + cfg.SUPABASE_ANON_KEY);
