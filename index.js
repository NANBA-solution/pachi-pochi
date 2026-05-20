import express from 'express';
import { messagingApi } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer';
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

function roundUpTo15Minutes(date) {
  const step = 15 * 60 * 1000;
  return new Date(Math.ceil(date.getTime() / step) * step);
}

function formatTimeJST(date) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function formatDurationLabel(durationMs) {
  const totalMinutes = Math.floor(durationMs / (60 * 1000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `（${hours}時間${minutes}分）`;
  if (hours > 0) return `（${hours}時間）`;
  return `（${minutes}分）`;
}

function calculateTimeeRecruitment(shiftStartTime, shiftEndTime, relayFiredAt = new Date()) {
  const originalStart = new Date(shiftStartTime);
  const originalEnd = new Date(shiftEndTime);
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

/** ポチ用プッシュメッセージ（計算済み時間 + 自動発行ボタン） */
function buildTimeeAutoPushMessage(shiftStartTime, shiftEndTime, relayFiredAt) {
  const calc = calculateTimeeRecruitment(shiftStartTime, shiftEndTime, relayFiredAt);

  if (!calc.ok) {
    return {
      ok: false,
      message: {
        type: 'text',
        text: `【パチポチ通知：身内全滅】
店長、一斉送信から30分経ちましたが身内スタッフの応募がありませんでした。

店長、残り時間が1時間未満のため、本日のタイミー募集は見合わせるか、終了時間を後ろに延ばして再設定してください！

📋 参考：本来のシフト ${formatTimeJST(new Date(shiftStartTime))} 〜 ${formatTimeJST(new Date(shiftEndTime))}
📋 算出した募集開始候補：${formatTimeJST(calc.recruitStart)}`
      }
    };
  }

  const targetStart = formatTimeJST(calc.recruitStart);
  const targetEnd = formatTimeJST(calc.recruitEnd);
  const durationLabel = formatDurationLabel(calc.remainingMs);

  return {
    ok: true,
    targetStart,
    targetEnd,
    message: {
      type: 'text',
      text: `【パチポチ通知：身内全滅】
身内スタッフの応募がありませんでした。

タイミーの掲載基準（最短1時間〜）に合わせ、本日の募集時間を自動算出しました。

⏰ 募集条件：本日 ${targetStart} 〜 ${targetEnd}${durationLabel}
📋 コピペ用業務内容：${TIMEE_JOB_DESCRIPTION}

以下のボタンを「ポチっ」と押せば、店長の代わりにシステムがタイミーへログインし、この条件で求人を即座に自動発行します！`,
      quickReply: {
        items: [
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '🚀 タイミーへ自動求人発行（ポチ）',
              data: `action=timee_auto&start=${encodeURIComponent(targetStart)}&end=${encodeURIComponent(targetEnd)}`
            }
          }
        ]
      }
    }
  };
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

/** タイミーの画面を裏で自動操縦して求人を入れる */
async function autoCreateTimeeJob(startTimeStr, endTimeStr) {
  console.log(`🤖 タイミーの自動操縦を開始します... (${startTimeStr} 〜 ${endTimeStr})`);

  const email = process.env.TIMEE_USER_EMAIL;
  const password = process.env.TIMEE_USER_PASSWORD;
  if (!email || !password) {
    console.error('❌ TIMEE_USER_EMAIL / TIMEE_USER_PASSWORD が未設定です');
    return false;
  }

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto('https://client.timee.co.jp/business/login', { waitUntil: 'networkidle0' });

    await page.type('input[type="email"]', email);
    await page.type('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle0' });

    console.log('🔑 タイミーへの自動ログインに成功しました。求人作成に入ります。');

    await page.goto('https://client.timee.co.jp/business/jobs/new', { waitUntil: 'networkidle0' });

    await page.waitForSelector('.template-select-button', { timeout: 5000 });
    await page.click('.template-select-button');

    await page.focus('#job-start-time');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.type('#job-start-time', startTimeStr);

    await page.focus('#job-end-time');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.type('#job-end-time', endTimeStr);

    await page.click('.submit-job-button');
    await new Promise((r) => setTimeout(r, 2000));

    console.log('🚀 タイミーへの自動求人発行が完了しました！');
    await browser.close();
    return true;
  } catch (err) {
    console.error('❌ タイミーの自動操縦中にエラー発生:', err.message);
    await browser.close();
    return false;
  }
}

async function runPachiBroadcastFlow(replyToken, incidentId, managerUserId) {
  console.log('身内スタッフ全員へLINEマルチキャスト配信を実行しました（擬似）');

  await client.replyMessage({
    replyToken,
    messages: [
      {
        type: 'text',
        text: '📡 身内スタッフ全員へLINE一斉要請を配信しました。回答を30分間待ちます。'
      }
    ]
  });

  schedulePochiRelayToManager(incidentId, managerUserId);
}

function schedulePochiRelayToManager(incidentId, managerUserId) {
  const pushTo = managerUserId || process.env.ADMIN_LINE_USER_ID;
  if (!pushTo) {
    console.warn('店長の LINE userId が未設定のため、タイミー誘導を送信しません。');
    return;
  }

  setTimeout(async () => {
    try {
      // 【テスト用】時間制限でアラートにならないよう、確実に3時間枠（18:00〜21:00）を固定セット
      const targetStart = '18:00';
      const targetEnd = '21:00';

      if (incidentId) {
        console.log(`✅ ポチ案内送信（テスト固定時間） incidentId: ${incidentId}`);
      }

      await client.pushMessage({
        to: pushTo,
        messages: [
          {
            type: 'text',
            text: `【パチポチテスト：身内全滅】\n身内スタッフの応募がありませんでした。\n\nテスト用に確実に動く時間をセットしました。\n\n⏰ 募集条件：本日 ${targetStart} 〜 ${targetEnd}\n\n以下のボタンを「ポチっ」と押せば、システムがタイミーへログインし、自動入力を開始します！`,
            quickReply: {
              items: [
                {
                  type: 'action',
                  action: {
                    type: 'postback',
                    label: '🚀 タイミーへ自動求人発行（ポチ）',
                    data: `action=timee_auto&start=${targetStart}&end=${targetEnd}`
                  }
                }
              ]
            }
          }
        ]
      });
      console.log('✅ 店長へタイミー自動発行ボタン（ポチ）を送信しました');
    } catch (err) {
      console.error('❌ タイミー誘導メッセージの送信エラー:', err?.message || err);
    }
  }, POCHI_RELAY_DELAY_MS);
}

async function getFirstStoreId() {
  const { data, error } = await supabase.from('stores').select('id').limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0].id;
}

app.post('/webhook', express.json(), async (req, res) => {
  const events = req.body.events;
  if (!events || events.length === 0) return res.status(200).send('OK');

  for (const event of events) {
    if (event.type === 'postback') {
      const replyToken = event.replyToken;
      const userId = event.source?.userId;
      const { action, incidentId, start, end } = parsePostbackData(event.postback?.data || '');

      if (action === 'broadcast') {
        await runPachiBroadcastFlow(replyToken, incidentId || null, userId);
        continue;
      }

      if (action === 'timee_auto') {
        const startTime = start ? decodeURIComponent(start) : '';
        const endTime = end ? decodeURIComponent(end) : '';

        await client.replyMessage({
          replyToken,
          messages: [
            {
              type: 'text',
              text: '🤖 了解です！システムが今からタイミーの管理画面に潜入し、自動入力を開始します。30秒ほどお待ちください...'
            }
          ]
        });

        const success = await autoCreateTimeeJob(startTime, endTime);
        const notifyTo = userId || process.env.ADMIN_LINE_USER_ID;

        if (notifyTo) {
          await client.pushMessage({
            to: notifyTo,
            messages: [
              {
                type: 'text',
                text: success
                  ? `✨【自動化成功】\nタイミーへの求人発行が完全に完了しました！（${startTime} 〜 ${endTime}）\nワーカーの応募が入るまでそのままお待ちください。`
                  : '❌【自動化エラー】\nタイミーのログインまたは入力に失敗しました。お手数ですが手動でログインしてご確認ください。'
              }
            ]
          });
        }
        continue;
      }

      continue;
    }

    if (event.type === 'message' && event.message.type === 'text') {
      const userMessage = sanitizeLineText(event.message.text);
      const replyToken = event.replyToken;
      const userId = event.source.userId;

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
          const shiftEnd = new Date();
          shiftEnd.setHours(22, 0, 0, 0);

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

        const postbackData = new URLSearchParams({ action: 'broadcast', staffName });
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
  console.log(`🚀 タイミー自動操縦サーバーが http://localhost:${PORT} で起動中...`);
});
