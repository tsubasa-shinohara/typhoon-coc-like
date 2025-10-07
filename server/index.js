import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import OpenAI from 'openai';

const app = express();
app.use(cors());
app.use(bodyParser.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== 基本設定 ======
const dramaMode = true;
const MIN_TURNS = 5; // 最低ターン（ドラマ性のため）
const END_TURNS = 8; // 伸びすぎ防止の自動終了

const EVAC_INFO = ['なし', '高齢者等避難', '避難指示', '緊急安全確保'];
const hasAnyJMA = (jma) =>
  (jma?.special?.length || 0) +
  (jma?.warnings?.length || 0) +
  (jma?.advisories?.length || 0) >
  0;

const mergeState = (prev, updates = {}) => {
  const next = { ...prev, ...updates };
  if (updates.jma) next.jma = { ...(prev.jma || {}), ...updates.jma };
  if (updates.landslide)
    next.landslide = { ...(prev.landslide || {}), ...updates.landslide };
  return next;
};

// ---------- シナリオ生成（家族・住宅・時間帯） ----------
function choice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function generateInitialScenario() {
  const areas = ['沿岸部', '河川沿い', '住宅地', '高台', '山裾・斜面近く'];
  const floors = Math.random() < 0.6 ? 2 : Math.random() < 0.85 ? 1 : 3;
  const house = { floors, area: choice(areas) };

  const timeOfDay = choice(['夕方', '夜', '夜', '深夜']); // 夜多め

  // 家族（所在付き）
  const members = [{ name: 'あなた', role: 'player', location: 'home' }];
  if (Math.random() < 0.55)
    members.push({
      name: '配偶者',
      role: 'spouse',
      location: Math.random() < 0.8 ? 'home' : 'away',
    });
  if (Math.random() < 0.6)
    members.push({ name: '小学生の子ども', role: 'child', location: 'home' });
  if (Math.random() < 0.4)
    members.push({
      name: choice(['要介護の母', '自立の祖父']),
      role: 'elder',
      location: 'home',
    });
  if (Math.random() < 0.3)
    members.push({ name: choice(['小型犬', '猫']), role: 'pet', location: 'home' });

  // 1人くらい「不明」ケース
  if (members.length >= 3 && Math.random() < 0.25) {
    const idx = Math.floor(Math.random() * members.length);
    if (members[idx].role !== 'player') members[idx].location = 'unknown';
  }

  const shelter = choice(['第一小学校 体育館', '市民センター', '地区防災広場']);

  return { house, timeOfDay, family: members, shelter };
}

// ---------- 状態補正 ----------
function applySafetyRules(prev = {}, proposed = {}) {
  // ディープコピーで破壊を避ける
  const s = JSON.parse(JSON.stringify(prev || {}));

  // ターンを進める（必要に応じて既存ロジックに合わせてください）
  s.turn = (prev.turn || 0) + 1;

  // ===== updates の取り込み（AI出力を state へ反映） =====
  const u = proposed || {};

  // 単純フィールド
  if (typeof u.powerOutage === 'boolean') s.powerOutage = u.powerOutage;
  if (typeof u.floodLevel === 'string') s.floodLevel = u.floodLevel;      // "none|road|house_1f|house_2f"
  if (typeof u.river === 'string') s.riverInfo = u.river;            // "情報なし|氾濫注意情報|…"
  if (typeof u.evacuationInfo === 'string') s.evacuationInfo = u.evacuationInfo;
  if (typeof u.mobileSignal === 'string') s.mobileSignal = u.mobileSignal;
  if (typeof u.alertReceived === 'boolean') s.alertReceived = u.alertReceived;
  if (typeof u.alertType === 'string') s.alertType = u.alertType;

  // JMA（注意報・警報・特別警報）
  if (u.jma && typeof u.jma === 'object') {
    s.jma = {
      ...(s.jma || { special: [], warnings: [], advisories: [] }),
      ...u.jma,
    };
    // 型をそろえる（配列保証）
    s.jma.special = Array.isArray(s.jma.special) ? s.jma.special : (s.jma.special ? [s.jma.special] : []);
    s.jma.warnings = Array.isArray(s.jma.warnings) ? s.jma.warnings : (s.jma.warnings ? [s.jma.warnings] : []);
    s.jma.advisories = Array.isArray(s.jma.advisories) ? s.jma.advisories : (s.jma.advisories ? [s.jma.advisories] : []);
  } else {
    // s.jma が未定義なら初期化
    s.jma = s.jma || { special: [], warnings: [], advisories: [] };
  }

  // 土砂災害セクション
  if (u.landslide && typeof u.landslide === 'object') {
    s.landslide = {
      ...(s.landslide || { risk: 'none', info: 'なし', precursors: [] }),
      ...u.landslide,
    };
    s.landslide.precursors = Array.isArray(s.landslide.precursors) ? s.landslide.precursors : [];
  }

  // 家族所在（配列マージ）… name キーで上書き
  if (Array.isArray(u.familyLocations)) {
    const map = new Map((s.familyLocations || []).map(x => [x.name, x]));
    for (const f of u.familyLocations) {
      if (!f || !f.name) continue;
      const prevF = map.get(f.name) || { name: f.name, location: 'unknown' };
      map.set(f.name, { ...prevF, ...f });
    }
    s.familyLocations = Array.from(map.values());
  }

  // 帰宅 ETA
  if (u.returnETAs && typeof u.returnETAs === 'object') {
    s.returnETAs = { ...(s.returnETAs || {}), ...u.returnETAs };
  }

  // 家族所在の初期化（名簿ベース）
  if (!s.familyLocations || s.familyLocations.length === 0) {
    s.familyLocations =
      (prev.scenario?.family || []).map(m => ({
        name: m.name,
        location: m.location || 'unknown'
      })) || [];
  }

  // ------------------------------------------------------------
  // 避難ステート（初期化）
  // ------------------------------------------------------------
  if (!s.evac) {
    s.evac = {
      status: 'none', // none | en_route | arrived | aborted
      route: [],
      hazards: [],
      shelterName: prev.scenario?.shelter || '避難所',
      distanceLeft: 100, // 0で到着
      journeyLog: [],
    };
  }
  if (!Array.isArray(s.evac.journeyLog)) s.evac.journeyLog = [];

  // ------------------------------------------------------------
  // proposed.evac の安全マージ（上書き事故を防止）
  // ------------------------------------------------------------
  if (proposed.evac) {
    const {
      journeyLog: incomingJourneyLog,
      journeySnippet,
      distanceLeft,
      status,
      route,
      hazards,
      shelterName,
      // 他フィールドは無視
    } = proposed.evac;

    if (typeof status === 'string') s.evac.status = status;
    if (Array.isArray(route)) s.evac.route = route;
    if (Array.isArray(hazards)) s.evac.hazards = hazards;
    if (typeof shelterName === 'string') s.evac.shelterName = shelterName;
    if (typeof distanceLeft === 'number') {
      s.evac.distanceLeft = Math.max(0, distanceLeft);
    }

    // journeyLog配列が来たら安全に追記
    if (Array.isArray(incomingJourneyLog)) {
      for (const item of incomingJourneyLog) {
        const text = typeof item === 'string' ? item : (item?.text ?? '');
        if (text) s.evac.journeyLog.push({ turn: s.turn, text });
      }
    }

    // 1件スニペット（文字列）も追記
    if (typeof journeySnippet === 'string' && journeySnippet.trim()) {
      s.evac.journeyLog.push({ turn: s.turn, text: journeySnippet.trim() });
    }
  }

  // 避難を開始したターン：在宅→避難中へ
  if ((prev.evac?.status || 'none') !== 'en_route' && s.evac.status === 'en_route') {
    s.familyLocations = (s.familyLocations || []).map(x => ({
      ...x,
      location: x.location === 'home' ? 'en_route' : x.location,
    }));
  }

  // 避難中は距離を減らす
  if (s.evac.status === 'en_route' && typeof s.evac.distanceLeft === 'number' && s.evac.distanceLeft > 0) {
    const speedPerTurn = 25; // ←お好みで調整
    s.evac.distanceLeft = Math.max(0, s.evac.distanceLeft - speedPerTurn);
    s.evac.journeyLog.push({ turn: s.turn, text: `避難中：残り${s.evac.distanceLeft}m` });
  }

  // 距離0で到着
  if (s.evac.status === 'en_route' && s.evac.distanceLeft === 0) {
    s.evac.status = 'arrived';
    s.familyLocations = (s.familyLocations || []).map(x => ({
      ...x,
      location: (x.location === 'home' || x.location === 'en_route' || x.location === 'away')
        ? 'arrived'
        : x.location,
    }));
    s.evac.journeyLog.push({ turn: s.turn, text: '避難所に到着しました。' });
  }

  // ------------------------------------------------------------
  // 帰宅ETA（家族個別）: 取り込み + 初期化 + カウントダウン
  // ------------------------------------------------------------
  if (!s.returnETAs) s.returnETAs = {};
  if (!s.splitPlans) s.splitPlans = {}; // { name: 'near_shelter' }

  // 1) AIからの ETA を取り込む（away/unknownのみ）
  if (proposed.returnETAs && typeof proposed.returnETAs === 'object') {
    const locMap = Object.fromEntries((s.familyLocations || []).map(x => [x.name, x.location]));
    for (const [name, val] of Object.entries(proposed.returnETAs)) {
      if (typeof val === 'number' && ['away', 'unknown'].includes(locMap[name] || 'unknown')) {
        s.returnETAs[name] = val;
      }
    }
  }

  // 2) ETA 未設定の away/unknown にデフォルト付与
  const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
  (s.familyLocations || []).forEach(p => {
    if (['away', 'unknown'].includes(p.location) && s.returnETAs[p.name] == null) {
      s.returnETAs[p.name] = (p.location === 'away') ? rand(2, 4) : rand(3, 6);
    }
  });

  // 3) 毎ターンのカウントダウンと到着処理
  for (const name of Object.keys(s.returnETAs)) {
    if (s.splitPlans[name] === 'near_shelter') continue; // 既に分散避難した人はノーカウント
    const person = (s.familyLocations || []).find(x => x.name === name);
    if (!person) continue;
    if (!['away', 'unknown'].includes(person.location)) continue;

    const eta = s.returnETAs[name];
    if (typeof eta === 'number' && eta > 0) s.returnETAs[name] = eta - 1;

    // ETA=0 で到着。
    if (s.returnETAs[name] === 0) {
      // 警報・行動情報などが出ているかで帰宅/分散避難を分岐
      const warningsActive =
        (s.evacuationInfo && s.evacuationInfo !== 'なし') ||
        (Array.isArray(s.jma?.warnings) && s.jma.warnings.length > 0) ||
        (Array.isArray(s.jma?.special) && s.jma.special.length > 0);

      const idx = (s.familyLocations || []).findIndex(x => x.name === name);
      if (idx >= 0) {
        if (warningsActive) {
          // 近隣避難所へ（分散避難）
          s.familyLocations[idx].location = 'arrived';
          s.splitPlans[name] = 'near_shelter';
        } else {
          // 自宅へ帰宅
          s.familyLocations[idx].location = 'home';
        }
      }
    }
  }
  // === 台風通過（自然終了）判定 ===
  // 「なし / 情報なし / 未定義」を広く“静穏”とみなすヘルパー
  const isNone = (v) => v == null || v === 'なし' || v === '情報なし';
  const arrNone = (a) => {
    if (a == null) return true;                  // 未定義 → 静穏扱い
    if (Array.isArray(a)) return a.length === 0; // 空配列 → 静穏
    return a === 'なし' || a === '情報なし';
  };

  // JMA（気象庁）関連が全部 静穏？
  const jma = s.jma || {};
  const noJMA =
    arrNone(jma.special) &&
    arrNone(jma.warnings) &&
    arrNone(jma.advisories);

  // 河川情報が静穏？
  const noRiver =
    isNone(s.river) || isNone(s.river?.status) || isNone(s.riverInfo);

  // 行動を促す情報（高齢者等避難 / 避難指示 / 緊急安全確保）がなし？
  const noEvacInfo = isNone(s.evacuationInfo);

  // 停電・避難中などは“静穏”でもゲーム継続にしたいならここで除外
  const notMoving = s.evac?.status !== 'en_route';

  // 今ターンが静穏か
  const calmNow = noJMA && noRiver && noEvacInfo;

  // --- JMA フォールバック：AIが空ならターンに応じて最低1件入れる ---
  const noJMAProvided =
    (!s.jma?.special?.length) &&
    (!s.jma?.warnings?.length) &&
    (!s.jma?.advisories?.length);

  if (noJMAProvided) {
    const t = s.turn || 1;
    if (t <= 2) {
      s.jma.advisories.push('強風注意報');
    } else if (t <= 4) {
      s.jma.warnings.push('大雨警報');
    } else {
      // 5ターン以降は特別警報 or 収束（10%）
      if (Math.random() < 0.1) {
        s.jma.advisories.push('大雨注意報');
      } else {
        s.jma.special.push('暴風特別警報');
      }
    }
  }

  // 連続静穏カウント（calmStreak）を更新
  s.calmStreak = (calmNow && notMoving) ? (prev.calmStreak || 0) + 1 : 0;

  // 5ターン連続で静穏 かつ 移動中でない → 自然終了
  if (s.calmStreak >= 5 && s.turn >= MIN_TURNS && notMoving && !s.gameEnded) {
    s.gameEnded = true;
    s.ending = {
      type: 'typhoon_passed',
      summary: '台風は通過し、風雨は弱まりました。あなたの判断と行動により家族は安全に過ごせました。',
      // 簡易スコア：所在が unknown でない人数比
      safetyScore: (() => {
        const total = (s.familyLocations?.length || 1);
        const safe = (s.familyLocations || []).filter(f => f.location !== 'unknown').length;
        return Math.round((safe / total) * 100);
      })(),
      turnEnded: s.turn,
    };
  }

  // ゲーム終了時にフェーズを明示的に更新
  if (s.gameEnded && !s.phase) {
    s.phase = 'ended';
  }

  // === チャイム検知 → エリアメール受信処理 ===
  const allText = JSON.stringify(proposed || '');
  const chimeKeywords = ['チャイム', 'ピロン', 'エリアメール', '警報音', '通知音'];
  const heardChime = chimeKeywords.some(k => allText.includes(k));

  if (heardChime) {
    s.alerts = s.alerts || [];
    if (!s.alerts.includes('エリアメール受信')) {
      s.alerts.push('エリアメール受信');
      s.evacuationInfo = s.evacuationInfo || '高齢者等避難'; // デフォルト反応（初期レベル）
      // エリアメール発信時に行動段階を上げる（確率的に）
      const stepUp = Math.random();
      if (stepUp > 0.6) s.evacuationInfo = '避難指示';
      if (stepUp > 0.9) s.evacuationInfo = '緊急安全確保';
    }
  }

  // 念のため
  if (!Array.isArray(s.evac.journeyLog)) s.evac.journeyLog = [];

  return s;
}

// ---------- SYSTEM（ドラマ＋土砂前兆＋道中＋家族所在） ----------
const SYSTEM = `
あなたは「物語演出AI」。各ターンは助言なしの短い情景描写のみ。JSONだけを返すこと。

返却形式:
{
  "narration": "30〜120字。音・匂い・光、家族の表情、建物のきしみ、携帯の振動など。助言や結論は禁止。",
  "updates": {
    "powerOutage": true/false,
    "floodLevel": "none|road|house_1f|house_2f",
    "jma": { "special":[], "warnings":[], "advisories":[] },
    "river": "情報なし|氾濫注意情報|氾濫警戒情報|氾濫危険情報|氾濫発生情報",
    "evacuationInfo": "なし|高齢者等避難|避難指示|緊急安全確保",
    "family": "unknown|safe|injured|missing",
    "mobileSignal": "通話可|不通",
    "alertReceived": true/false,
    "alertType": "なし|高齢者等避難|避難指示|緊急安全確保",
    "landslide": {
      "risk": "none|low|medium|high",
      "info": "なし|注意|警戒|危険|発生",
      "precursors": []
    },
    "familyLocations": [
      { "name":"配偶者", "location":"home|away|unknown|arrived" }
    ],
    "returnETAs": { "配偶者": 3, "自立の祖父": 2 }, // away/unknown の人は必ず数値を入れる（残りターン）
    "evac": {
      "status": "none|en_route|arrived|aborted",
      "route": [],
      "hazards": [],
      "distanceLeft": 60,
      "journeySnippet": "暗い坂道で枝が折れて転がる。足音だけがやけに響く。"
    },
    "scoreDelta": { "safety": -2..2, "compassion": -2..2, "composure": -2..2 }
  }
}

演出方針:
- 時間帯（夜/深夜なら暗さ・静けさ）を強く反映する。
- 土砂前兆：井戸の水が濁る／斜面から湧水／木がざわめく／地鳴り／土の匂いの変化 など。
- エリアメールは「甲高いチャイム」「ポケットが震える」など1文で描写（助言はしない）。
- 家族は確認できるまで "unknown"。在宅/外出/不明/到着は updates.familyLocations で更新。
- ユーザーが移動を示唆すれば、updates.evac を段階進行し、毎ターン1文で道中の断片（journeySnippet）を出す。
- 一貫性重視、奇跡や超常は禁止。
- away/unknown の家族には、毎ターンかならず updates.returnETAs を含める（残りターンは増減させない）。欠落は不可。
- ユーザーが「状況を確認」「安否確認」「電話/連絡」などを示したターンは、updates.family を "safe" にできる範囲で更新。
// --- 確率的な気象進行ロジック ---
- ターンが進むごとに、天候を段階的に悪化・変化させること。
  例：
  - 1〜2ターン目: 注意報レベル（大雨注意報・強風注意報など）
  - 3〜4ターン目: 警報レベル（大雨警報・暴風警報・洪水警報など）
  - 5ターン以降: 特別警報や避難指示など、重大なフェーズ
- 一度「特別警報」「避難指示」「緊急安全確保」を出したら、
  その後は段階的に収束（警報→注意報→なし）へ戻すこと。
- updates.jma.special / warnings / advisories のいずれかを
  毎ターン少なくとも1つ埋める（完全な空配列は禁止）。
- 「停電」や「氾濫注意情報」も3ターン目以降にランダムで発生させる。
// --- 気象進行ルール ---
- 各ターンで updates.jma を必ず生成すること。空配列は禁止。
- 出力例：
  updates.jma = {
    special: ["暴風特別警報"],       // 特別警報（まれ）
    warnings: ["大雨警報", "洪水警報"], // 警報（中頻度）
    advisories: ["強風注意報"]        // 注意報（頻度高）
  }
- 1〜2ターン目：注意報（強風・大雨など）を中心に。
- 3〜4ターン目：警報（大雨・洪水・暴風など）を出す。
- 5ターン目以降：特別警報を出すか、徐々に解除（警報→注意報→なし）に移行。
- updates.jma は毎ターンの状況変化を表すため、配列の中身はランダムでも構わない。
- 完全に静かなターン（全てなし）は、10%未満の確率でのみ許可する。
`;

// ---------- API ----------
app.post('/api/facilitator', async (req, res) => {
  try {
    const { messages, lastRoll, state } = req.body;
    const payload = { messages, lastRoll, state, dramaMode };

    const systemPlus =
      SYSTEM +
      (lastRoll ? `\nd100=${lastRoll}` : '') +
      `\nシナリオ（家族・住宅・時間帯）: ${JSON.stringify(
        state?.scenario || {}
      )}`;

    const r = await client.responses.create({
      model: 'gpt-4o-mini',
      input: [
        { role: 'system', content: systemPlus },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    });

    let out = (r.output_text || '').trim();
    let data = null;
    if (out.startsWith('{')) {
      try {
        data = JSON.parse(out);
      } catch { }
    }
    if (!data) {
      const m = out.match(/\{[\s\S]*\}$/);
      if (m) {
        try {
          data = JSON.parse(m[0]);
        } catch { }
      }
    }

    const narration = data?.narration || '（描写が生成できませんでした）';
    const updates = data?.updates || {};

    let next = applySafetyRules(state || {}, updates);

    // スコア反映
    const d = updates?.scoreDelta || {};
    next.scores = {
      safety: (next.scores?.safety || 0) + (d.safety || 0),
      compassion: (next.scores?.compassion || 0) + (d.compassion || 0),
      composure: (next.scores?.composure || 0) + (d.composure || 0),
    };

    // 物語ログ
    const lastAction = messages?.slice(-1)?.[0]?.content || '';
    next.story = [...(next.story || []), { turn: next.turn - 1, narration, action: lastAction }];

    // 自動終了ガード
    if (next.turn > END_TURNS || next.gameEnded) {
      next.phase = 'ended';
    }

    // 結果生成
    let finalReport = null;
    if (next.phase === 'ended') {
      finalReport = buildFinalReport(next);
    }

    res.json({ text: narration, newState: { ...next, finalReport } });
  } catch (e) {
    console.error('[AI ERROR]', e?.message || e);
    res.status(500).json({ error: 'AI応答エラー', detail: e?.message || String(e) });
  }
});

// 結果レポート
function buildFinalReport(s) {
  const { safety = 0, compassion = 0, composure = 0 } = s.scores || {};
  const scoreTag = (v) => (v >= 3 ? '◎' : v >= 1 ? '○' : v <= -3 ? '×' : v <= -1 ? '△' : '–');

  const keyMoments = s.story?.slice(0, 3).map((m) => `・T${m.turn}：${m.narration}`) || [];
  const lastMoments = s.story?.slice(-2).map((m) => `・T${m.turn}：${m.narration}`) || [];

  const journey = Array.isArray(s.evac?.journeyLog)
    ? s.evac.journeyLog.map((j) => `・T${j.turn}：${j.text}`)
    : [];
  const evacLine =
    s.evac?.status === 'arrived'
      ? `避難先「${s.evac?.shelterName || '避難所'}」に到着。経路: ${(s.evac?.route || []).join('→') || '—'
      }`
      : s.evac?.status === 'aborted'
        ? `避難は断念。理由: ${(s.evac?.hazards || []).join('、') || '状況悪化'}`
        : `避難は未完了（status: ${s.evac?.status || 'none'}）`;

  const advice = [
    s.floodLevel !== 'none'
      ? '浸水想定区域では早めの垂直避難・移動計画を。'
      : '非常用ライトとラジオの所在を家族で共有しましょう。',
    s.powerOutage
      ? '停電時は冷蔵庫の開閉を最小化、充電は計画的に。'
      : 'モバイルバッテリーは満充電・分散保管が安心です。',
    s.landslide?.risk !== 'none'
      ? '土砂前兆（濁り水・湧水・木のざわめき等）を感じたら、斜面から離れた上階・遠方へ。'
      : '山裾の家では前兆サインを家族で共有しておきましょう。',
  ];

  return {
    headline: s.jma?.special?.length ? '嵐の只中で' : '荒天の夜をこえて',
    summaryBullets: [...keyMoments, '…', ...lastMoments, evacLine, ...journey.slice(-3)],
    scores: { safety, compassion, composure },
    advice,
  };
}

// ランダム設定をクライアントへ
app.get('/api/new-scenario', (_, res) => res.json({ scenario: generateInitialScenario() }));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Server ready: http://localhost:${PORT}`));
