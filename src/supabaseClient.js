import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// どちらかが空ならコンソールに即座に警告を出す
if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    '🚨【環境変数エラー】.env.local からSupabaseのキーを読み込めません。\n' +
      'ファイル名が正確に「.env.local」であるか、変数名の頭に「VITE_」が付いているか確認してください。'
  );
}

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder'
);
