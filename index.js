import express from 'express';
import { messagingApi } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const app = express();
const PORT = 3000;

// 1. Supabaseクライアントの初期化
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const { MessagingApiClient } = messagingApi;
const client = new MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});

// 前回のテストで作成した店舗のIDを自動取得する関数
async function getFirstStoreId() {
  const { data, error } = await supabase.from('stores').select('id').limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0].id;
}

app.post('/webhook', express.json(), async (req, res) => {
  const events = req.body.events;
  if (!events || events.length === 0) return res.status(200).send('OK');

  for (let event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      // 【バグ修正】LINE送信時の予期せぬ改行（\n）をすべて消去してお掃除する
      const userMessage = event.message.text.replace(/\r?\n/g, '').trim();
      const replyToken = event.replyToken;
      const userId = event.source.userId;

      // 「登録：」または「登録:」で始まる場合（全角半角どちらも対応）
      if (userMessage.startsWith('登録：') || userMessage.startsWith('登録:')) {
        const staffName = userMessage.replace('登録：', '').replace('登録:', '').trim();
        const storeId = await getFirstStoreId();

        if (!storeId) {
          await client.replyMessage({
            replyToken: replyToken,
            messages: [{ type: 'text', text: '❌ 店舗データがデータベースに見つかりません。' }]
          });
          continue;
        }

        console.log(`データベースへ登録を試みます: ${staffName} (LINE ID: ${userId})`);

        // 2. Supabaseのstaffsテーブルへデータを挿入（または更新）
        const { data, error } = await supabase
          .from('staffs')
          .upsert([
            {
              store_id: storeId,
              line_user_id: userId,
              full_name: staffName,
              is_active: true
            }
          ], { onConflict: 'line_user_id' })
          .select();

        if (error) {
          console.error('❌ Supabaseへの登録エラー:', error.message);
          await client.replyMessage({
            replyToken: replyToken,
            messages: [{ type: 'text', text: '❌ 登録に失敗しました。管理者に連絡してください。' }]
          });
        } else {
          console.log('✅ Supabaseへのスタッフ登録に成功:', data);
          await client.replyMessage({
            replyToken: replyToken,
            messages: [{ type: 'text', text: `🎉 ${staffName}さんのスタッフ登録が完了しました！\n（店舗ID: ${storeId}）` }]
          });
        }
      } else {
        // それ以外のメッセージは通常のオウム返し
        await client.replyMessage({
          replyToken: replyToken,
          messages: [{ type: 'text', text: `「${userMessage}」ですね！\nスタッフ登録する場合は「登録：自分の名前」と送信してください。` }]
        });
      }
    }
  }
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`🚀 データベース連動サーバーが http://localhost:${PORT} で起動中...`);
});
