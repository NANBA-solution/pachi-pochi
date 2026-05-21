import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    if (!ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY is not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { taskTitle, tone, elapsedDays } = await req.json();

    if (!taskTitle || !tone) {
      return new Response(JSON.stringify({ error: 'Missing parameters' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const systemPrompt = `
あなたは妻から家事タスクを委任された夫に対して、LINEでリマインド（催促）を送る優秀なAIアシスタントです。
以下の制約ルールを厳格に守ってメッセージを生成してください。

【制約ルール】
1. 挨拶や余計な解説、解説のナレーション（「〜風に変換しました」等）は一切出力せず、夫に送信する【LINE本文のみ】を直接出力すること。
2. 感情を揺さぶり、ユーモアを交えつつも、「やらなきゃ」と思わせる文面にすること。
3. 文末に、夫がLINEで1タップで完了報告するための導線（例:「完了したら下のボタンを押してね」など）を自然に添えること。
4. 経過日数（elapsedDays）が大きいほど、徐々にプレッシャーや深刻度、あるいは笑いのエスカレーション度合いを上げること。

【指定されたトーンのペルソナ】
- 普通モード：親しみやすい日常会話。少し呆れつつも優しい。
- 丁寧モード：新入社員が上司に恐る恐るリマインドするようなビジネス敬語。
- 法務部モード：冷徹な法律文書・規約風。家庭内信用格付けの低下や、契約不履行によるペナルティを匂わせる。
- 武士モード：戦国時代の武士やお奉行様風。「〜でござる」「然るに」「切腹もの」などの時代劇言葉。
- 皮肉モード：冷ややかでインテリジェンスなアイロニー。直接怒らず、哲学的に相手の怠惰を突く。
- AI秘書モード：徹底的にデータ分析風。「前週比120%の未処理率」など数字を捏造してロジカルに詰める。
- 外国人モード：日本語を一生懸命勉強しているカタコトの外国人風。純粋無垢な疑問で夫の罪悪感を刺激する（例：「ナゼまだヤラナイデスカ？」）。
`;

    const userPrompt = `
以下の情報に基づいて、夫への催促LINEを1通生成してください。

- 頼まれている家事（タスク）: ${taskTitle}
- 指定トーン: ${tone}
- 放置されている経過日数: ${elapsedDays} 日目
`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: 0.7
      })
    });

    const data = await response.json();

    if (!response.ok) {
      const apiError = data?.error?.message ?? JSON.stringify(data);
      return new Response(JSON.stringify({ error: apiError }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: response.status
      });
    }

    const generatedMessage = data.content?.[0]?.text?.trim();
    if (!generatedMessage) {
      return new Response(JSON.stringify({ error: 'Empty response from Claude API' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 502
      });
    }

    return new Response(JSON.stringify({ message: generatedMessage }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500
    });
  }
});
