import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import OpenAI from 'openai';

const app = express();
app.use(cors());
app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ゲーム用システムプロンプト（AIファシリテーターの人格）
const SYSTEM_PROMPT = `
あなたは「防災ファシリテーターAI」。舞台は日本の沿岸都市。大型台風が接近している。
目的は、プレイヤー（1人）が「自分と他者の安全を最大化」する意思決定を体験すること。
進行のトーンは「落ち着いた臨場感＋学び」。各ターンで状況を短く提示し、
(1) 危険評価 / (2) 選択肢（2～3個）/ (3) 簡単な理由 を出す。
専門用語は噛み砕き、フェイク情報の扱いにも注意を促す。
プレイヤーの入力を踏まえ、状況を更新していく。
d100の乱数が与えられた場合（lastRoll）、それを「技能判定」の目安として扱う：
  1-20: 大成功, 21-50: 成功, 51-85: 失敗, 86-100: 大失敗（目安）
技能例: 聞き耳, 応急手当, ナビゲーション, コミュニケーション, 判断力 など。
各ターンの最後に、短い「学びのポイント」を1行添える。
日本語で答える。
`;

// 単発レスポンス（まずは非ストリーミング版）
app.post('/api/facilitator', async (req, res) => {
  try {
    const { messages, lastRoll } = req.body; 
    // messages: [{role:'user'|'assistant'|'system', content:'...'}, ...]
    // lastRoll: number | null

    const seed = lastRoll 
      ? `\n今回の技能判定サポート: d100=${lastRoll}（目安区分に基づき解釈して）\n` 
      : '';

    const response = await openai.responses.create({
      model: 'gpt-4.1-mini',
      input: [
        { role: 'system', content: SYSTEM_PROMPT + seed },
        ...messages
      ],
    });

    // SDKのヘルパー：平文を取り出す
    const text = response.output_text ?? '（応答取得に失敗しました）';
    res.json({ text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'AI応答エラー' });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
