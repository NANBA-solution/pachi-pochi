import express from 'express';
import { messagingApi } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const app = express();
const PORT = 3000;

/** スタッフ登録コマンドの先頭に許可する表記（全角コロン / 半角コロン） */
const REGISTRATION_PREFIXES = ['登録：', '登録:'];

/**
 * 欠勤インシデントの仮シフト（開始 = 受信から3時間後、終了 = 開始からこの時間後）
 * Supabase incidents: absent_staff_id, store_id, shift_start_time, shift_end_time, status（'pending' 等）
 */
const ABSENCE_SHIFT_START_OFFSET_MS = 3 * 60 * 60 * 1000;
const ABSENCE_SHIFT_DURATION_MS = 8 * 60 * 60 * 1000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const { MessagingApiClient } = messagingApi;
const client = new MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});

async function getFirstStoreId() {
  const { data, error } = await supabase.from('stores').select('id').limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0].id;
}

/**
 * LINE から届いたテキストから \n / \r をすべて除去し、前後の空白を trim する（デバッグ用の正規化）
 */
function sanitizeLineText(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\r/g, '').replace(/\n/g, '').trim();
}

/**
 * メッセージがスタッフ登録コマンドかどうかを判定し、該当する場合はプレフィックス除去後の名前を返す
 * @returns {{ ok: true, staffName: string } | { ok: false }}
 */
function parseRegistrationCommand(userMessage) {
  const prefix = REGISTRATION_PREFIXES.find((p) => userMessage.startsWith(p));
  if (!prefix) return { ok: false };
  const staffName = userMessage.slice(prefix.length).trim();
  return { ok: true, staffName };
}

/** postback data を query 形式として解釈する */
function parsePostbackData(data) {
  try {
    return Object.fromEntries(new URLSearchParams(data).entries());
  } catch {
    return {};
  }
}

app.post('/webhook', express.json(), async (req, res) => {
  const events = req.body.events;
  if (!events || events.length === 0) return res.status(200).send('OK');

  for (const event of events) {
    if (event.type === 'postback') {
      const replyToken = event.replyToken;
      const userId = event.source?.userId;
      const adminId = process.env.ADMIN_LINE_USER_ID;
      const { action, incident_id: incidentId } = parsePostbackData(event.postback?.data || '');

      if (action === 'start_broadcast' && incidentId) {
        if (adminId && userId !== adminId) {
          await client.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: 'この操作は店長アカウントからのみ実行できます。' }]
          });
          continue;
        }
        console.log('一斉送信開始（ポストバック） incident_id:', incidentId);
        await client.replyMessage({
          replyToken,
          messages: [
            {
              type: 'text',
              text: `インシデント ${incidentId} について、一斉送信フローを開始する処理は今後ここに実装してください。`
            }
          ]
        });
      }
      continue;
    }

    if (event.type === 'message' && event.message.type === 'text') {
      const userMessage = sanitizeLineText(event.message.text);
      const replyToken = event.replyToken;
      const userId = event.source.userId;

      const registration = parseRegistrationCommand(userMessage);

      if (registration.ok) {
        const { staffName } = registration;
        const storeId = await getFirstStoreId();

        if (!storeId) {
          await client.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: '❌ 店舗データがデータベースに見つかりません。' }]
          });
          continue;
        }

        if (!staffName) {
          await client.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: '❌ 名前が空です。「登録：山田太郎」のように送信してください。' }]
          });
          continue;
        }

        console.log(`データベースへ登録を試みます: ${staffName} (LINE ID: ${userId})`);

        const { data, error } = await supabase
          .from('staffs')
          .upsert(
            [
              {
                store_id: storeId,
                line_user_id: userId,
                full_name: staffName,
                is_active: true
              }
            ],
            { onConflict: 'line_user_id' }
          )
          .select();

        if (error) {
          console.error('❌ Supabaseへの登録エラー:', error.message);
          await client.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: '❌ 登録に失敗しました。管理者に連絡してください。' }]
          });
        } else {
          console.log('✅ Supabaseへのスタッフ登録に成功:', data);
          await client.replyMessage({
            replyToken,
            messages: [
              { type: 'text', text: `🎉 ${staffName}さんのスタッフ登録が完了しました！` }
            ]
          });
        }
        continue;
      }

      if (userMessage.includes('欠勤')) {
        const { data: staff, error: staffErr } = await supabase
          .from('staffs')
          .select('id, store_id, full_name')
          .eq('line_user_id', userId)
          .maybeSingle();

        if (staffErr) {
          console.error('❌ スタッフ照会エラー:', staffErr.message);
          await client.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: '❌ スタッフ情報の取得に失敗しました。しばらくしてから再度お試しください。' }]
          });
          continue;
        }

        if (!staff) {
          await client.replyMessage({
            replyToken,
            messages: [
              {
                type: 'text',
                text: '❌ スタッフとして登録が見つかりません。先に「登録：お名前」で登録してください。'
              }
            ]
          });
          continue;
        }

        const now = new Date();
        const shiftStart = new Date(now.getTime() + ABSENCE_SHIFT_START_OFFSET_MS);
        const shiftEnd = new Date(shiftStart.getTime() + ABSENCE_SHIFT_DURATION_MS);

        const { data: incidentRows, error: incidentErr } = await supabase
          .from('incidents')
          .insert({
            absent_staff_id: staff.id,
            store_id: staff.store_id,
            shift_start_time: shiftStart.toISOString(),
            shift_end_time: shiftEnd.toISOString(),
            status: 'pending'
          })
          .select('id');

        if (incidentErr) {
          console.error('❌ incidents インサートエラー:', incidentErr.message, {
            code: incidentErr.code,
            details: incidentErr.details,
            hint: incidentErr.hint
          });
          await client.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: '❌ 欠勤の記録に失敗しました。管理者に連絡してください。' }]
          });
          continue;
        }

        const incidentRow = incidentRows?.[0];
        if (!incidentRow?.id) {
          console.error('❌ incidents インサート後に id を取得できませんでした:', incidentRows);
          await client.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: '❌ 欠勤の記録に失敗しました。管理者に連絡してください。' }]
          });
          continue;
        }

        const incidentId = incidentRow.id;
        const staffName = staff.full_name || 'スタッフ';
        console.log('✅ 欠勤インシデント作成:', incidentId, staffName);

        const adminId = process.env.ADMIN_LINE_USER_ID;
        if (adminId) {
          try {
            await client.pushMessage({
              to: process.env.ADMIN_LINE_USER_ID,
              messages: [
                {
                  type: 'text',
                  text: `【パチポチ通知】\n${staffName}さんから欠勤申請が届きました。\n\n本日シフト外の身内スタッフへ一斉送信（穴埋め要請）を行いますか？\n\n「一斉送信を開始する」と送信してください。`
                }
              ]
            });
          } catch (pushErr) {
            console.error('❌ 店長へのプッシュ送信エラー:', pushErr?.message || pushErr);
          }
        } else {
          console.warn('ADMIN_LINE_USER_ID が未設定のため、店長へプッシュしません。');
        }

        await client.replyMessage({
          replyToken,
          messages: [
            {
              type: 'text',
              text: `欠勤の連絡を受け付けました。店長へ通知しました。（記録ID: ${incidentId}）`
            }
          ]
        });
        continue;
      }

      await client.replyMessage({
        replyToken,
        messages: [
          {
            type: 'text',
            text: `「${userMessage}」ですね！\nスタッフ登録する場合は「登録：自分の名前」または「登録:自分の名前」と送信してください。`
          }
        ]
      });
    }
  }

  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`🚀 データベース連動サーバーが http://localhost:${PORT} で起動中...`);
});
