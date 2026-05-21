import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('⚠️ Supabaseの環境変数が設定されていません。 .env.local を確認してください。');
}

export const supabase = createClient(supabaseUrl ?? '', supabaseAnonKey ?? '');
