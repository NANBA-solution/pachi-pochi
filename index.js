import express from 'express';
import { messagingApi } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const app = express();
const PORT = 3000;

/** 身内応募待ち（本番30分 / テスト3秒）後にタイミー誘導を送るまでの遅延 */
const POCHI_RELAY_DELAY_MS = 3 * 1000;

/** 一斉送信後、タイミー計算時に「経過した」とみなす待機時間（本番30分） */
const BROADCAST_WAIT_MS = 30 * 60 * 1000;

/** タイミー最短掲載単位 */
const TIMEE_MIN_RECRUITMENT_MS = 60 * 60 * 1000;

const TIMEE_JOB_DESCRIPTION = '「ホールの補助・洗い場・接客」';

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

function parsePostbackData(data) {
  try {
    return Object.fromEntries(new URLSearchParams(data).entries());
  } catch {
    return {};
  }
}

/** 15分単位で切り上げ */
function roundUpTo15Minutes(date) {
  const step = 15 * 60 * 1000;
  return new Date(Math.ceil(date.getTime() / step) * step);
}

/** JST で HH:mm 表示 */
function formatTimeJST(date) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

/** 募集時間の表示用（例：（3時間）、（1時間30分）） */
function formatDurationLabel(durationMs) {
  const totalMinutes = Math.floor(durationMs / (60 * 1000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `（${hours}時間${minutes}分）`;
  if (hours > 0) return `（${hours}時間）`;
  return `（${minutes}分）`;
}

/**
 * タイミー募集開始・終了を自動計算（最短1時間〜）
 * @param {string} shiftStartTime ISO
 * @param {string} shiftEndTime ISO
 * @param {Date} relayFiredAt setTimeout 発火時刻
 */
function calculateTimeeRecruitment(shiftStartTime, shiftEndTime, relayFiredAt = new Date()) {
  const originalStart = new Date(shiftStartTime);
  const originalEnd = new Date(shiftEndTime);

  // テストでは3秒後に発火するが、計算上は「30分経過後」の時刻として扱う
  const assumedNow = new Date(
    relayFiredAt.getTime() + BROADCAST_WAIT_MS - POCHI_RELAY_DELAY_MS
  );

  let recruitStart;
  if (assumedNow < originalStart) {
    recruitStart = new Date(originalStart);
  } else {
    const fifteenMinutesLater = new Date(assumedNow.getTime() + 15 * 60 * 1000);
    recruitStart = roundUpTo15Minutes(fifteenMinutesLater);
  }

  const recruitEnd = new Date(originalEnd);
  const remainingMs = recruitEnd.getTime() - recruitStart.getTime();

  return {
    assumedNow,
    recruitStart,
    recruitEnd,
    remainingMs,
    ok: remainingMs >= TIMEE_MIN_RECRUITMENT_MS
  };
}

function buildTimeeGuidanceMessage(shiftStartTime, shiftEndTime, relayFiredAt) {
  const calc = calculateTimeeRecruitment(shiftStartTime, shiftEndTime, relayFiredAt);

  if (!calc.ok) {
    return `【パチポチ通知：身内全滅】
店長、一斉送信から30分経ちましたが身内スタッフの応募がありませんでした。

店長、残り時間が1時間未満のため、本日のタイミー募集は見合わせるか、終了時間を後ろに延ばして再設定してください！

📋 参考：本来のシフト ${formatTimeJST(new Date(shiftStartTime))} 〜 ${formatTimeJST(new Date(shiftEndTime))}
📋 算出した募集開始候補：${formatTimeJST(calc.recruitStart)}`;
  }

  const startLabel = formatTimeJST(calc.recruitStart);
  const endLabel = formatTimeJST(calc.recruitEnd);
  const durationLabel = formatDurationLabel(calc.remainingMs);

  return `【パチポチ通知：身内全滅】
店長、一斉送信から30分経ちましたが身内スタッフの応募がありませんでした。

現場を維持するため、タイミー（Timee）での募集に切り替えます。システムが最短1時間ルールに沿って募集時間を自動計算しました。

⏰ 募集条件：本日 ${startLabel} 〜 ${endLabel}${durationLabel}
📋 コピペ用業務内容：${TIMEE_JOB_DESCRIPTION}

以下のリンクを「ポチっ」と押して、この条件で求人を発行してください！
👉 タイミー求人作成画面を開く`;
}

async function fetchIncidentShiftTimes(incidentId) {
  const { data, error } = await supabase
    .from('incidents')
    .select('shift_start_time, shift_end_time')
    .eq('id', incidentId)
    .maybeSingle();

  if (error) {
    console.error('❌ インシデント取得エラー:', error.message);
    return null;
  }
  return data;
}

/** パチ → ポチへの自動リレー（一斉送信開始 + タイミー誘導スケジュール） */
async function runPachiBroadcastFlow(replyToken, incidentId) {
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

  schedulePochiRelayToManager(incidentId);
}

async function getFirstStoreId() {
  const { data, error } = await supabase.from('stores').select('id').limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0].id;
}

/**
 * パチ完了後、ポチ（タイミー誘導）を店長へ push（incidents のシフト時刻から募集枠を算出）
 */
function schedulePochiRelayToManager(incidentId) {
  const adminId = process.env.ADMIN_LINE_USER_ID;
  if (!adminId) {
    console.warn('ADMIN_LINE_USER_ID が未設定のため、タイミー誘導メッセージを送信しません。');
    return;
  }

  setTimeout(async () => {
    const relayFiredAt = new Date();

    try {
      let messageText;

      if (!incidentId) {
        console.warn('incidentId がないため、タイミー時間を固定文面で送信します。');
        messageText = buildTimeeGuidanceMessage(
          relayFiredAt.toISOString(),
          new Date(relayFiredAt.getTime() + 3 * TIMEE_MIN_RECRUITMENT_MS).toISOString(),
          relayFiredAt
        );
      } else {
        const incident = await fetchIncidentShiftTimes(incidentId);
        if (!incident?.shift_start_time || !incident?.shift_end_time) {
          console.error('❌ シフト時刻を取得できませんでした incidentId:', incidentId);
          await client.pushMessage({
            to: adminId,
            messages: [
              {
                type: 'text',
                text: '【パチポチ】欠勤インシデントのシフト情報が見つかりません。管理者に連絡してください。'
              }
            ]
          });
          return;
        }

        messageText = buildTimeeGuidanceMessage(
          incident.shift_start_time,
          incident.shift_end_time,
          relayFiredAt
        );

        const calc = calculateTimeeRecruitment(
          incident.shift_start_time,
          incident.shift_end_time,
          relayFiredAt
        );
        console.log('✅ タイミー募集時間を算出:', {
          incidentId,
          assumedNow: calc.assumedNow.toISOString(),
          recruitStart: calc.recruitStart.toISOString(),
          recruitEnd: calc.recruitEnd.toISOString(),
          remainingMinutes: Math.floor(calc.remainingMs / 60000),
          ok: calc.ok
        });
      }

      await client.pushMessage({
        to: adminId,
        messages: [{ type: 'text', text: messageText }]
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
    if (event.type === 'postback') {
      const replyToken = event.replyToken;
      const { action, incidentId } = parsePostbackData(event.postback?.data || '');

      if (action === 'broadcast') {
        await runPachiBroadcastFlow(replyToken, incidentId || null);
      }
      continue;
    }

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
        let incidentId = null;

        if (staffId) {
          const now = new Date();
          const shiftEnd = new Date(now.getTime() + 8 * 60 * 60 * 1000);
          const { data: incidentRows, error: incidentErr } = await supabase
            .from('incidents')
            .insert([
              {
                store_id: storeId,
                absent_staff_id: staffId,
                shift_start_time: now.toISOString(),
                shift_end_time: shiftEnd.toISOString(),
                status: 'pending'
              }
            ])
            .select('id');

          if (incidentErr) {
            console.error('❌ incidents インサートエラー:', incidentErr.message);
          } else {
            incidentId = incidentRows?.[0]?.id ?? null;
            console.log(`✅ 欠勤インシデント作成完了: ${staffName} (id: ${incidentId})`);
          }
        }

        const postbackData = new URLSearchParams({
          action: 'broadcast',
          staffName
        });
        if (incidentId) postbackData.set('incidentId', incidentId);

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
                      type: 'postback',
                      label: '👉 身内へ一斉送信する（パチ）',
                      data: postbackData.toString()
                    }
                  }
                ]
              }
            }
          ]
        });
      } else {
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
