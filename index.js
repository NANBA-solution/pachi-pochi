import express from 'express';
import { messagingApi } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const app = express();
const PORT = 3000;

/** 店長がクイックリプライで送る一斉送信開始アクション（パチ → ポチの入口） */
const BROADCAST_ACTION_TEXT = 'アクション：身内へ一斉送信を開始する';

/** 身内応募待ち（本番30分 / テスト3秒）後にタイミー誘導を送るまでの遅延 */
const POCHI_RELAY_DELAY_MS = 3 * 1000;

const TIMEE_GUIDANCE_MESSAGE = `【パチポチ通知：身内全滅】
店長、一斉送信から30分経ちましたが身内スタッフの応募がありませんでした。

現場を維持するため、タイミー（Timee）での募集に切り替えます。システムが最低3時間ルールをクリアする時間を自動計算しました。

⏰ 募集条件：本日 18:00 〜 21:00（3時間）
📋 コピペ用業務内容：「ホールの補助・洗い場・接客」

以下のリンクを「ポチっ」と押して、この条件で求人を発行してください！
👉 タイミー求人作成画面を開く`;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const { MessagingApiClient } = messagingApi;
const client = new MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});

function sanitizeLineText(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\r/g, '').replace(/\n/g, '').trim();
}

async function getFirstStoreId() {
  const { data, error } = await supabase.from('stores').select('id').limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0].id;
}

/**
 * パチ完了後、ポチ（タイミー誘導）を店長へ push する（テスト時は数秒遅延）
 */
function schedulePochiRelayToManager() {
  const adminId = process.env.ADMIN_LINE_USER_ID;
  if (!adminId) {
    console.warn('ADMIN_LINE_USER_ID が未設定のため、タイミー誘導メッセージを送信しません。');
    return;
  }

  setTimeout(async () => {
    try {
      await client.pushMessage({
        to: adminId,
        messages: [{ type: 'text', text: TIMEE_GUIDANCE_MESSAGE }]
      });
      console.log('✅ 店長へタイミー誘導メッセージ（ポチ）を送信しました');
    } catch (err) {
      console.error('❌ タイミー誘導メッセージの送信エラー:', err?.message || err);
    }
  }, POCHI_RELAY_DELAY_MS);
}

app.post('/webhook', express.json(), async (req, res) => {
  const events = req.body.events;
  if (!events || events.length === 0) return res.status(200).send('OK');

  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      const rawMessage = event.message.text;
      const userMessage = sanitizeLineText(rawMessage);
      const replyToken = event.replyToken;
      const userId = event.source.userId;

      // 1. スタッフ登録の処理
      if (userMessage.startsWith('登録：') || userMessage.startsWith('登録:')) {
        const staffName = userMessage.replace('登録：', '').replace('登録:', '').trim();
        const storeId = await getFirstStoreId();

        if (!storeId) {
          await client.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: '❌ 店舗データが見つかりません。' }]
          });
          continue;
        }

        const { error: upsertErr } = await supabase.from('staffs').upsert(
          [{ store_id: storeId, line_user_id: userId, full_name: staffName, is_active: true }],
          { onConflict: 'line_user_id' }
        );

        if (upsertErr) {
          console.error('❌ スタッフ登録エラー:', upsertErr.message);
          await client.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: '❌ 登録に失敗しました。管理者に連絡してください。' }]
          });
          continue;
        }

        await client.replyMessage({
          replyToken,
          messages: [{ type: 'text', text: `🎉 ${staffName}さんのスタッフ登録が完了しました！` }]
        });
      } else if (userMessage.includes('欠勤')) {
        // 【核心】欠勤申請の検知（1タップ目：パチ）
        const storeId = await getFirstStoreId();

        if (!storeId) {
          await client.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: '❌ 店舗データが見つかりません。' }]
          });
          continue;
        }

        // LINE IDからスタッフ名を取得
        const { data: staffData, error: staffErr } = await supabase
          .from('staffs')
          .select('id, full_name')
          .eq('line_user_id', userId)
          .maybeSingle();

        if (staffErr) {
          console.error('❌ スタッフ照会エラー:', staffErr.message);
        }

        const staffName = staffData?.full_name ?? 'スタッフ';
        const staffId = staffData?.id ?? null;

        if (staffId) {
          const now = new Date();
          const shiftEnd = new Date(now.getTime() + 8 * 60 * 60 * 1000); // 8時間後
          const { error: incidentErr } = await supabase.from('incidents').insert([
            {
              store_id: storeId,
              absent_staff_id: staffId,
              shift_start_time: now.toISOString(),
              shift_end_time: shiftEnd.toISOString(),
              status: 'pending'
            }
          ]);

          if (incidentErr) {
            console.error('❌ incidents インサートエラー:', incidentErr.message);
          } else {
            console.log(`✅ 欠勤インシデント作成完了: ${staffName}`);
          }
        }

        // 無料プランでも確実に動く「ボタン付き店長通知（Flex Message風クイックリプライ）」を送信
        await client.replyMessage({
          replyToken,
          messages: [
            {
              type: 'text',
              text: `【パチポチ通知】\n${staffName}さんから欠勤申請を受け付けました。\n\n店長、ここから「パチ」っと1タップで本日シフト外の身内スタッフ全員へ一斉に穴埋め要請を配信しますか？`,
              quickReply: {
                items: [
                  {
                    type: 'action',
                    action: {
                      type: 'message',
                      label: '👉 身内へ一斉送信する（パチ）',
                      text: BROADCAST_ACTION_TEXT
                    }
                  }
                ]
              }
            }
          ]
        });
      } else if (userMessage === BROADCAST_ACTION_TEXT) {
        // 【核心】パチ → ポチへの自動リレー（2タップ目：ポチ待ち → タイミー誘導）
        console.log('身内スタッフ全員へLINEマルチキャスト配信を実行しました（擬似）');

        await client.replyMessage({
          replyToken,
          messages: [
            {
              type: 'text',
              text: '【パチポチ】身内スタッフへ一斉送信を開始しました。応募がない場合、まもなくタイミー募集の案内をお送りします。'
            }
          ]
        });

        schedulePochiRelayToManager();
      } else {
        // 通常のオウム返し
        await client.replyMessage({
          replyToken,
          messages: [{ type: 'text', text: `「${userMessage}」ですね！` }]
        });
      }
    }
  }
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`🚀 パチポチコアサーバーが http://localhost:${PORT} で起動中...`);
});
