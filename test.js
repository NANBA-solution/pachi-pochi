import { createClient } from '@supabase/supabase-js';
import 'dotenv/config'; // .envファイルを読み込むライブラリ

// 1. Supabaseクライアントの初期化
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function runTest() {
  console.log('🚀 Supabaseへの接続テストを開始します...');

  // 2. stores（店舗）テーブルにテストデータを1件インサート
  const { data, error } = await supabase
    .from('stores')
    .insert([
      { 
        store_name: 'テスト居酒屋 パチポチ', 
        base_hourly_wage: 1200,
        timee_template_url: 'https://worker.timee.co.jp/business/jobs/new'
      }
    ])
    .select(); // 挿入成功したデータをそのまま返す設定

  if (error) {
    console.error('❌ データ挿入に失敗しました:', error.message);
    return;
  }

  console.log('✅ データ挿入に成功しました！作成されたデータはこちらです：');
  console.log(data);
}

runTest();
