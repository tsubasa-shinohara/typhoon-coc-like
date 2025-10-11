import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import OpenAI from 'openai';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(cors());
app.use(bodyParser.json());

let client = null;
try {
  if (process.env.OPENAI_API_KEY) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } else {
    console.warn('⚠️  OPENAI_API_KEY not set - AI narration will be skipped');
  }
} catch (err) {
  console.warn('⚠️  Failed to initialize OpenAI client:', err.message);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ====== 基本設定 ======
const dramaMode = true;
const MIN_TURNS = 5; // 最低ターン（ドラマ性のため）
const END_TURNS = 12; // フェーズベース: 4フェーズ × 3ターン = 12ターン（T+6hは結果表示のみ）

const EVAC_INFO = ['なし', '高齢者等避難', '避難指示', '緊急安全確保'];

// ====== フェーズ定義 ======
const PHASES = [
  { id: "T-24h", name: "予想到達24時間前", turnsInPhase: 3, baseAlertLevel: "なし" },
  { id: "T-12h", name: "予想到達12時間前", turnsInPhase: 3, alertOptions: ["なし", "注意報"] },
  { id: "T-6h", name: "予想到達6時間前", turnsInPhase: 3, alertOptions: ["なし", "注意報", "警報"] },
  { id: "T-3h", name: "予想到達3時間前", turnsInPhase: 3, alertOptions: ["なし", "注意報", "警報", "特別警報"] },
  { id: "T+6h", name: "通過後6時間経過", turnsInPhase: 3, baseAlertLevel: "なし" }
];

// ====== 選択肢データ読み込み ======
let CHOICES_DATA;
try {
  const choicesPath = join(__dirname, 'data', 'choices.json');
  CHOICES_DATA = JSON.parse(readFileSync(choicesPath, 'utf-8'));
  console.log(`選択肢データ読み込み成功: ${CHOICES_DATA.choices.length}件`);
} catch (err) {
  console.error('選択肢データの読み込みエラー:', err);
  CHOICES_DATA = { categories: [], choices: [] };
}

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


  const hasElderly = members.some(m => m.role === 'elder');
  const carAvailable = Math.random() < 0.6;

  const shelter = choice(['第一小学校 体育館', '市民センター', '地区防災広場']);

  return { house, timeOfDay, family: members, shelter, hasElderly, carAvailable };
}

// ---------- 状態補正 ----------
function applySafetyRules(prev = {}, proposed = {}) {
  // ディープコピーで破壊を避ける
  const s = JSON.parse(JSON.stringify(prev || {}));

  if (!s.currentPhase) s.currentPhase = 0; // PHASESのインデックス
  if (!s.turnInPhase) s.turnInPhase = 0;
  if (!s.totalTurns) s.totalTurns = 0;
  if (!s.selectedChoiceIds) s.selectedChoiceIds = [];
  if (!s.phaseData) s.phaseData = {};
  if (!s.flags) s.flags = [];
  
  // Turn increment moved to endpoint handler to only increment when a choice is selected
  s.turn = s.totalTurns; // 互換性のため
  
  if (s.currentPhase >= 4 && !s.gameEnded) {
    s.gameEnded = true;
    s.phase = 'ended';
  }

  // ===== updates の取り込み（AI出力を state へ反映） =====
  const u = proposed || {};

  // 単純フィールド
  if (typeof u.powerOutage === 'boolean') s.powerOutage = u.powerOutage;
  if (typeof u.floodLevel === 'string') s.floodLevel = u.floodLevel;      // "none|road|house_1f|house_2f"
  if (typeof u.river === 'string') s.riverInfo = u.river;            // "情報なし|氾濫注意情報|…"
  if (typeof u.evacuationInfo === 'string') s.evacuationInfo = u.evacuationInfo;
  if (typeof u.mobileSignal === 'string') s.mobileSignal = u.mobileSignal;
  if (typeof u.carUse === 'boolean') s.carUse = u.carUse;
  if (typeof u.neighborOutreach === 'boolean') s.neighborOutreach = u.neighborOutreach;
  if (typeof u.routeConfirmed === 'boolean') s.routeConfirmed = u.routeConfirmed;
  if (typeof u.alertReceived === 'boolean') s.alertReceived = u.alertReceived;
  if (typeof u.alertType === 'string') s.alertType = u.alertType;
  if (typeof u.currentFloor === 'number') s.currentFloor = u.currentFloor;

  // 初期化: プレイヤーの現在階（デフォルト1階）
  if (!s.currentFloor) s.currentFloor = 1;

  // 階数制約の検証
  const maxFloors = prev.scenario?.house?.floors || 2;
  if (s.currentFloor < 1) s.currentFloor = 1;
  if (s.currentFloor > maxFloors) s.currentFloor = maxFloors;

  // AI出力の階数制約違反を防ぐ
  if (u.currentFloor && u.currentFloor > maxFloors) {
    s.currentFloor = maxFloors;
  }

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
      
      const newLocation = (prevF.location === 'home' && f.location === 'unknown') 
        ? 'home' 
        : (f.location || prevF.location);
      
      map.set(f.name, { ...prevF, ...f, location: newLocation });
    }
    s.familyLocations = Array.from(map.values());
  }

  // 帰宅 ETA
  if (u.returnETAs && typeof u.returnETAs === 'object') {
    s.returnETAs = { ...(s.returnETAs || {}), ...u.returnETAs };
  }

  // 連絡済み家族の追跡
  if (!s.contactedFamily) s.contactedFamily = {};

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
      evacuationStartTurn: 0,
      turnsRequired: 2,
      turnsElapsed: 0,
      hasKittenEvent: false,
      hasFloodEvent: false,
      journeyLog: [],
    };
  }
  if (!Array.isArray(s.evac.journeyLog)) s.evac.journeyLog = [];

  // ------------------------------------------------------------
  // lastAction を最初に宣言（全体で使用）
  // ------------------------------------------------------------
  const lastAction = prev._lastAction || '';

  // ------------------------------------------------------------
  // ------------------------------------------------------------
  const neighborKeywords = ['声をかけ', '呼びかけ', '周囲', '近所', '周りに', '隣人', 'コンタクト', '声掛け'];
  if (neighborKeywords.some(k => lastAction.includes(k))) {
    s.neighborOutreach = true;
  }

  const routeKeywords = ['経路', 'ルート', '地図', 'マップ'];
  const confirmKeywords = ['確認', 'チェック', '調べ'];
  const hasRouteKeyword = routeKeywords.some(k => lastAction.includes(k));
  const hasConfirmKeyword = confirmKeywords.some(k => lastAction.includes(k));
  if (hasRouteKeyword && hasConfirmKeyword) {
    s.routeConfirmed = true;
  }

  // ------------------------------------------------------------
  // proposed.evac の安全マージ（上書き事故を防止）
  // ------------------------------------------------------------
  if (proposed.evac) {
    const {
      journeyLog: incomingJourneyLog,
      journeySnippet,
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

  if (s.evac.status === 'en_route' && s.evac.turnsRequired) {
    let reduction = 0;
    if (s.neighborOutreach) reduction += 1;
    if (s.routeConfirmed) reduction += 1;
    
    if (reduction > 0) {
      s.evac.turnsRequired = Math.max(1, s.evac.turnsRequired - reduction);
    }
  }

  if (s.carUse && !s.scenario?.hasElderly && s.evac.status === 'en_route') {
    if (!s.evac.hazards) s.evac.hazards = [];
    if (!s.evac.hazards.includes('道路冠水')) {
      s.evac.hazards.push('道路冠水');
    }
  }

  const floorKeywords = ['階', '2階', '3階', '上階', '階段'];
  const hasFloorKeyword = floorKeywords.some(k => lastAction.includes(k));


  // ------------------------------------------------------------
  // ------------------------------------------------------------
  const evacuationKeywords = ['避難所', '避難', '移動', '向かう', '出発', '出る', '目指す'];
  const preparationKeywords = ['準備', '用意', 'チェック'];
  const hasEvacuationKeyword = evacuationKeywords.some(k => lastAction.includes(k)) && !hasFloorKeyword;
  const hasPreparationKeyword = preparationKeywords.some(k => lastAction.includes(k));
  const isEvacuating = hasEvacuationKeyword && !hasPreparationKeyword;
  
  if (isEvacuating && (s.evac.status === 'none' || s.evac.status === 'aborted')) {
    s.evac.status = 'en_route';
  }

  // 避難を開始したターン：在宅→避難中へ
  if ((prev.evac?.status || 'none') !== 'en_route' && s.evac.status === 'en_route') {
    s.evac.evacuationStartTurn = s.turn;
    s.evac.turnsElapsed = 0;
    s.evac.turnsRequired = 2;

    const neighborKeywords = ['声をかけ', '呼びかけ', '周囲', '近所', '周りに', '隣人'];
    const calledOutToNeighbors = neighborKeywords.some(k => lastAction.includes(k));
    if (calledOutToNeighbors) {
      s._neighborCalloutBonus = { compassion: 2, safety: 1 };
    }

    s.familyLocations = (s.familyLocations || []).map(x => ({
      ...x,
      location: x.location === 'home' ? 'en_route' : x.location,
    }));
  }

  if (s.evac.status === 'en_route') {
    s.evac.turnsElapsed = s.turn - s.evac.evacuationStartTurn;

    const hasKittenKeyword = (lastAction.includes('子猫') || lastAction.includes('猫')) &&
      (lastAction.includes('助ける') || lastAction.includes('救う') || lastAction.includes('保護'));
    if (hasKittenKeyword && !s.evac.hasKittenEvent) {
      s.evac.hasKittenEvent = true;
      s.evac.turnsRequired += 1;
      s.evac.journeyLog.push({ turn: s.turn, text: '子猫を助けたため、避難に1ターン余分にかかります。' });
    }

    if (!s.evac.hasFloodEvent && Math.random() < 0.25) {
      s.evac.hasFloodEvent = true;
      s.evac.turnsRequired += 1;
      s.evac.journeyLog.push({ turn: s.turn, text: '経路が冠水しており、迂回が必要です。避難に1ターン余分にかかります。' });
    }
  }

  if (s.evac.status === 'en_route' && s.evac.turnsElapsed >= s.evac.turnsRequired) {
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

  // === 家族への連絡検知 ===
  // lastAction（ユーザーのメッセージ）から家族への連絡を検知
  const contactKeywords = ['確認', '連絡', '電話', '安否', '状況', '様子'];
  const hasContactKeyword = contactKeywords.some(k => lastAction.includes(k));

  if (hasContactKeyword) {
    // 家族名簿の各メンバーをチェック
    (prev.scenario?.family || []).forEach(member => {
      const name = member.name;
      // メッセージに家族の名前が含まれているかチェック
      if (lastAction.includes(name)) {
        s.contactedFamily[name] = true;
        
        const idx = (s.familyLocations || []).findIndex(x => x.name === name);
        if (idx >= 0 && s.familyLocations[idx].location === 'unknown') {
          s.familyLocations[idx].location = 'away';
        }
      }
    });
  }

  // lastActionを保存（次ターンで使用）
  s._lastAction = lastAction;

  // === 台風通過（自然終了）判定 ===
  // 「なし / 情報なし / 未定義」を広く"静穏"とみなすヘルパー
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

  const alertLevel = s.phaseAlertLevel || "なし";
  
  if (alertLevel === "なし") {
    s.jma.advisories = [];
    s.jma.warnings = [];
    s.jma.special = [];
  } else if (alertLevel === "注意報") {
    s.jma.advisories = ['大雨注意報', '強風注意報'];
    s.jma.warnings = [];
    s.jma.special = [];
    if (Math.random() < 0.3) s.jma.advisories.push('洪水注意報');
  } else if (alertLevel === "警報") {
    s.jma.advisories = [];
    s.jma.warnings = ['大雨警報', '暴風警報'];
    s.jma.special = [];
    if (Math.random() < 0.6) s.jma.warnings.push('洪水警報');
  } else if (alertLevel === "特別警報") {
    s.jma.advisories = [];
    s.jma.warnings = [];
    s.jma.special = ['大雨特別警報', '暴風特別警報'];
  }

  // === 大雨警報＋洪水警報で土砂災害警戒情報（組み合わせロジック維持） ===
  const rainWarn = (s.jma?.warnings || []).includes('大雨警報');
  const floodWarn = (s.jma?.warnings || []).includes('洪水警報');
  if (rainWarn && floodWarn) {
    s.landslide = s.landslide || {};
    s.landslide.info = '土砂災害警戒情報';
    s.landslide.risk = 'medium';
  }
  
  if (!s.scores) {
    s.scores = {
      生存度: 50,
      判断力: 50,
      貢献度: 50,
      準備度: 50,
      文化度: 50
    };
  }

  // --- 現在のJMA状態を判定 ---
  const hasAdvisories = Array.isArray(s.jma?.advisories) && s.jma.advisories.length > 0;
  const hasWarnings = Array.isArray(s.jma?.warnings) && s.jma.warnings.length > 0;
  const hasSpecial = Array.isArray(s.jma?.special) && s.jma.special.length > 0;

  // === 行動段階の自動追従（最後に移動） ===
  // ・警報が1つでも出たら「高齢者等避難」
  // ・高潮警報/高潮特別警報、または「土砂災害警戒情報」が出たら「避難指示」
  // ・高潮以外の“特別警報”が1つでも出たら「緊急安全確保」
  // ・一度上がったら最低2ターンは維持（ダウングレード抑制）
  {
    const rank = (v) => ({ 'なし': 0, '高齢者等避難': 1, '避難指示': 2, '緊急安全確保': 3 }[v] ?? 0);
    const maxBy = (...xs) => xs.reduce((a, b) => rank(b) > rank(a) ? b : a, 'なし');

    const W = Array.isArray(s.jma?.warnings) ? s.jma.warnings : [];
    const S = Array.isArray(s.jma?.special) ? s.jma.special : [];
    const anyWarning = W.length > 0;
    const anyTideWarnOrSpecial = [...W, ...S].some(n => n.includes('高潮'));
    const anySpecialExceptTide = S.some(n => !n.includes('高潮'));

    // ルールに基づく目標段階
    const target =
      anySpecialExceptTide ? '緊急安全確保'
        : (anyTideWarnOrSpecial || s.landslide?.info === '土砂災害警戒情報') ? '避難指示'
          : anyWarning ? '高齢者等避難'
            : 'なし';

    // 最低2ターン維持ロジック
    s._evacHold = s._evacHold ?? { level: 'なし', rest: 0 };
    const cur = s.evacuationInfo || 'なし';

    if (rank(target) > rank(cur)) {
      // 昇格：即時反映＋2ターン維持
      s.evacuationInfo = target;
      s._evacHold = { level: target, rest: 2 };
    } else if (rank(target) < rank(cur) && s._evacHold.rest > 0) {
      // 下降しそうでも維持
      s.evacuationInfo = s._evacHold.level;
      s._evacHold.rest -= 1;
    } else {
      // 横ばい or 維持期間満了
      s.evacuationInfo = target;
      if (rank(target) === rank(s._evacHold.level)) {
        // 同段階を継続 → 維持カウント消費
        if (s._evacHold.rest > 0) s._evacHold.rest -= 1;
      } else {
        // 目標が「なし」などへ変わった場合は維持解除
        s._evacHold = { level: target, rest: 0 };
      }
    }
  }

  // === 被災確率シナリオ（65%） ===
  if (!s.disasterOccurred && s.evacuationInfo === '緊急安全確保') {
    let shouldTriggerDisaster = false;
    let disasterReason = '';

    // シナリオ1: 避難中に緊急安全確保
    if (s.evac?.status === 'en_route') {
      if (Math.random() < 0.65) {
        shouldTriggerDisaster = true;
        disasterReason = '避難が間に合わず、避難経路で被災しました。緊急安全確保の発令が遅すぎました。';
      }
    }

    // シナリオ2: 崖付近でない + 1階待機中 + 緊急安全確保
    const isNearCliff = (prev.scenario?.house?.area || '').includes('山裾・斜面近く');
    if (!shouldTriggerDisaster && s.evac?.status === 'none' && !isNearCliff && s.currentFloor === 1) {
      if (Math.random() < 0.65) {
        shouldTriggerDisaster = true;
        disasterReason = '1階での待機中に浸水が急速に進み、被災しました。垂直避難が間に合いませんでした。';
      }
    }
  }

  // シナリオ3: 崖付近 + 自宅待機中 + 土砂災害警戒情報
  if (!s.disasterOccurred && s.evac?.status === 'none') {
    const isNearCliff = (prev.scenario?.house?.area || '').includes('山裾・斜面近く');
    if (isNearCliff && s.landslide?.info === '土砂災害警戒情報') {
      if (Math.random() < 0.65) {
        let shouldTriggerDisaster = false;
        let disasterReason = '';
        shouldTriggerDisaster = true;
        disasterReason = '土砂災害警戒情報発令中、斜面付近の自宅で待機していたため土砂崩れに巻き込まれました。早期避難が必要でした。';

        // 被災が発生した場合
        if (shouldTriggerDisaster) {
          s.disasterOccurred = true;
          s.gameEnded = true;
          s.phase = 'ended';
          s.ending = {
            type: 'disaster',
            summary: disasterReason,
            safetyScore: 0,
            turnEnded: s.turn,
          };

          // 家族全員の状態を更新
          s.familyLocations = (s.familyLocations || []).map(f => ({
            ...f,
            location: 'disaster'
          }));
        }
      }
    }
  }

  if (s.turn <= 2 && !hasAdvisories && !hasWarnings && !hasSpecial) {
    s.jma.advisories.push('強風注意報');
  }

  if (s.turn >= 3 && s.turn <= 4 && !hasWarnings && !hasSpecial) {
    if (hasAdvisories && !hasWarnings) {
      s.jma.warnings.push('大雨警報');
    } else if (!hasAdvisories && !hasWarnings) {
      s.jma.warnings.push('大雨警報');
    }
  }

  if (s.turn >= 5 && !hasSpecial) {
    const rainWarnDuration = s._warnDuration?.RAIN || 0;
    const windWarnDuration = s._warnDuration?.WIND || 0;
    
    if (rainWarnDuration >= 2 || windWarnDuration >= 2) {
      if (Math.random() < 0.9) {
        s.jma.special.push('大雨特別警報');
      } else {
        s.jma.special = [];
        if (s.jma.warnings.length === 0) {
          s.jma.advisories.push('大雨注意報');
        }
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
    }
  }

  // 念のため
  if (!Array.isArray(s.evac.journeyLog)) s.evac.journeyLog = [];

  return s;
}

function selectAlertLevel(prevLevel, options) {
  const levelRank = { "なし": 0, "注意報": 1, "警報": 2, "特別警報": 3 };
  const prevRank = levelRank[prevLevel] || 0;
  
  const validOptions = options.filter(opt => {
    const rank = levelRank[opt] || 0;
    return Math.abs(rank - prevRank) <= 1;
  });
  
  if (validOptions.length === 0) return options[0];
  
  const weights = validOptions.map(opt => {
    const rank = levelRank[opt] || 0;
    if (rank === prevRank) return 0.5;
    if (rank > prevRank) return 0.3;
    return 0.2;
  });
  
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const random = Math.random() * totalWeight;
  let cumWeight = 0;
  for (let i = 0; i < validOptions.length; i++) {
    cumWeight += weights[i];
    if (random <= cumWeight) return validOptions[i];
  }
  return validOptions[0];
}

function filterAvailableChoices(state) {
  const currentPhase = PHASES[state.currentPhase];
  const phaseId = currentPhase?.id || "T-24h";
  const alertLevel = state.phaseAlertLevel || "なし";
  
  return CHOICES_DATA.choices.filter(choice => {
    if (!choice.availableWhen.phases.includes(phaseId)) return false;
    if (!choice.availableWhen.alertLevels.includes(alertLevel)) return false;
    
    if (choice.availableWhen.conditions.requireItems) {
      const hasRequiredItems = choice.availableWhen.conditions.requireItems.every(
        item => (state.items || []).includes(item)
      );
      if (!hasRequiredItems) return false;
    }
    
    if (choice.availableWhen.conditions.requireFlags) {
      const hasRequiredFlags = choice.availableWhen.conditions.requireFlags.every(
        flag => (state.flags || []).includes(flag)
      );
      if (!hasRequiredFlags) return false;
    }
    
    if (choice.availableWhen.conditions.excludeEvacStatus) {
      const evacStatus = state.evac?.status || 'none';
      if (choice.availableWhen.conditions.excludeEvacStatus.includes(evacStatus)) {
        return false;
      }
    }
    
    if (choice.availableWhen.conditions.requireHouseFloors) {
      const houseFloors = state.scenario?.house?.floors || 1;
      if (houseFloors < choice.availableWhen.conditions.requireHouseFloors) {
        return false;
      }
    }
    
    return true;
  });
}

function weightedRandomChoice(choices) {
  if (!choices || choices.length === 0) return null;
  
  const totalWeight = choices.reduce((sum, c) => sum + (c.weight || 1), 0);
  let random = Math.random() * totalWeight;
  let cumWeight = 0;
  
  for (const choice of choices) {
    cumWeight += (choice.weight || 1);
    if (random <= cumWeight) {
      return choice;
    }
  }
  
  return choices[choices.length - 1];
}

function selectChoicesByTurn(availableChoices, turnInPhase, state) {
  const ACTIVE_CATEGORIES = ['情報系', 'コミュニケーション系', '物資準備系', '住宅対策系', '避難行動系'];
  const WAITING_CATEGORY = '待機・時間調整系';
  
  const unselectedChoices = availableChoices.filter(c => 
    !state.selectedChoiceIds || !state.selectedChoiceIds.includes(c.id)
  );
  
  if (unselectedChoices.length === 0) {
    return [
      { id: 'fallback_1', text: '現状を確認する', category: '情報系' },
      { id: 'fallback_2', text: '家族と話し合う', category: 'コミュニケーション系' },
      { id: 'fallback_3', text: '様子を見る', category: '待機・時間調整系' },
      { id: 'fallback_4', text: '情報を収集する', category: '情報系' }
    ];
  }
  
  const selected = [];
  const usedCategories = new Set();
  
  const triggeredChoices = unselectedChoices.filter(choice => {
    const requiredFlags = choice.availableWhen?.conditions?.requireFlags || [];
    if (requiredFlags.length === 0) return false;
    return requiredFlags.every(flag => (state.flags || []).includes(flag));
  });
  
  if (turnInPhase === 1) {
    const shuffledCategories = [...ACTIVE_CATEGORIES].sort(() => Math.random() - 0.5);
    const selectedCategories = shuffledCategories.slice(0, 4);
    
    state.phaseData = state.phaseData || {};
    state.phaseData.turn1Categories = selectedCategories;
    
    for (const category of selectedCategories) {
      const categoryChoices = unselectedChoices.filter(c => c.category === category);
      if (categoryChoices.length > 0) {
        const choice = weightedRandomChoice(categoryChoices);
        if (choice) {
          selected.push(choice);
          usedCategories.add(category);
        }
      }
    }
  } else if (turnInPhase === 2) {
    const turn1Cats = state.phaseData?.turn1Categories || [];
    const remainingCategories = ACTIVE_CATEGORIES.filter(cat => !turn1Cats.includes(cat));
    
    // Add remaining categories from Turn 1
    for (const category of remainingCategories) {
      const categoryChoices = unselectedChoices.filter(c => c.category === category);
      if (categoryChoices.length > 0) {
        const choice = weightedRandomChoice(categoryChoices);
        if (choice && !selected.find(s => s.id === choice.id)) {
          selected.push(choice);
          usedCategories.add(category);
        }
      }
    }
    
    // Add one waiting category choice
    const waitingChoices = unselectedChoices.filter(c => c.category === WAITING_CATEGORY);
    if (waitingChoices.length > 0) {
      const choice = weightedRandomChoice(waitingChoices);
      if (choice && !selected.find(s => s.id === choice.id)) {
        selected.push(choice);
        usedCategories.add(WAITING_CATEGORY);
      }
    }
    
    // Add triggered choices if available
    if (triggeredChoices.length > 0 && selected.length < 4) {
      const triggeredChoice = weightedRandomChoice(triggeredChoices);
      if (triggeredChoice && !selected.find(s => s.id === triggeredChoice.id)) {
        selected.push(triggeredChoice);
        usedCategories.add(triggeredChoice.category);
      }
    }
    
    // Fill remaining slots, ensuring no category duplication
    while (selected.length < 4 && selected.length < unselectedChoices.length) {
      const activeChoices = unselectedChoices.filter(c => 
        ACTIVE_CATEGORIES.includes(c.category) && 
        !selected.find(s => s.id === c.id) &&
        !usedCategories.has(c.category)
      );
      if (activeChoices.length === 0) break;
      const choice = weightedRandomChoice(activeChoices);
      if (choice) {
        selected.push(choice);
        usedCategories.add(choice.category);
      }
    }
  } else if (turnInPhase === 3) {
    // Add one waiting category choice (required)
    const waitingChoices = unselectedChoices.filter(c => c.category === WAITING_CATEGORY);
    if (waitingChoices.length > 0) {
      const choice = weightedRandomChoice(waitingChoices);
      if (choice) {
        selected.push(choice);
        usedCategories.add(WAITING_CATEGORY);
      }
    }
    
    // Add triggered choices if available
    if (triggeredChoices.length > 0 && selected.length < 4) {
      const triggeredChoice = weightedRandomChoice(triggeredChoices);
      if (triggeredChoice && !selected.find(s => s.id === triggeredChoice.id)) {
        selected.push(triggeredChoice);
        usedCategories.add(triggeredChoice.category);
      }
    }
    
    // Fill remaining slots, ensuring no category duplication
    while (selected.length < 4 && selected.length < unselectedChoices.length) {
      const activeChoices = unselectedChoices.filter(c => 
        ACTIVE_CATEGORIES.includes(c.category) && 
        !selected.find(s => s.id === c.id) &&
        !usedCategories.has(c.category)
      );
      if (activeChoices.length === 0) break;
      const choice = weightedRandomChoice(activeChoices);
      if (choice) {
        selected.push(choice);
        usedCategories.add(choice.category);
      }
    }
  }
  
  while (selected.length < 4 && selected.length < unselectedChoices.length) {
    const remaining = unselectedChoices.filter(c => !selected.find(s => s.id === c.id));
    if (remaining.length === 0) break;
    const choice = weightedRandomChoice(remaining);
    if (choice) {
      selected.push(choice);
    }
  }
  
  return selected;
}

function handleCustomEffect(effectId, state) {
  switch (effectId) {
    case 'dragon_summoner':
      if (Math.random() < 0.01) {
        return { 
          typhoonDiverted: true, 
          specialEvent: '龍使いが龍を呼び、台風の進路が変わった！' 
        };
      }
      return { 
        specialEvent: '龍使い『今回は龍の機嫌が悪いようだ...』少し台風の勢力が弱まった。' 
      };
    
    case 'vertical_evacuation':
      return { currentFloor: 2 };
    
    case 'start_evacuation':
      return { 
        evac: { 
          status: 'en_route',
          startTurn: state.totalTurns 
        } 
      };
    
    default:
      return {};
  }
}

// ---------- SYSTEM（ドラマ＋土砂前兆＋道中＋家族所在） ----------
const SYSTEM = `
あなたは「物語演出AI」。各ターンは助言なしの短い情景描写のみ。JSONだけを返すこと。

返却形式:
{
  "narration": "30〜120字。音・匂い・光、家族の表情、建物のきしみ、携帯の振動など。助言や結論は禁止。",
  "choices": ["短い行動案1","短い行動案2","短い行動案3"], // 省略禁止：毎ターン必ず3件。傾向は「安全優先」「共助優先」「情報確認」を混在
  "updates": {
    "powerOutage": true/false,
    "floodLevel": "none|road|house_1f|house_2f",
    "currentFloor": 1 | 2 | 3,
    "jma": { "special":[], "warnings":[], "advisories":[] },
    "river": "情報なし|氾濫注意情報|氾濫警戒情報|氾濫危険情報|氾濫発生情報",
    "evacuationInfo": "なし|高齢者等避難|避難指示|緊急安全確保",
    "family": "unknown|safe|injured|missing",
    "mobileSignal": "通話可|不通",
    "alertReceived": true/false,
    "alertType": "なし|高齢者等避難|避難指示|緊急安全確保",
    "carUse": true/false,
    "neighborOutreach": true/false,
    "routeConfirmed": true/false,
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
      "turnsElapsed": 1,
      "turnsRequired": 3,
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
- ユーザーが移動を示唆すれば、updates.evac を段階進行し、毎ターン1文で道中の断片（journeySnippet）を出す。避難は最短2ターンで完了し、子猫を助けたり経路が冠水している場合は追加で1ターンかかる。
- **【重要】建物の階数制約を厳守：scenario.house.floors が 1 なら「2階」は存在しない。「2階へ避難」「階段を上がる」などの描写は物理的に不可能。描写前に必ず scenario.house.floors を確認し、存在しない階への言及は絶対に避けること。currentFloor は scenario.house.floors を超えてはならない。**
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
- ユーザーが無言でも、必ず "choices" に 3 件の行動案を返すこと（省略禁止）。
- choices は 8〜20 文字程度の日本語・即時行動の命令形で、トーンはドラマチック。
  例：「祖母の手を取り二階へ」「子を先に避難路へ走らせる」「窓を離れ灯りを落とす」
- 3件の傾向は毎ターン「安全優先」「共助優先」「情報確認」を混在させる（順不同）。
- 直前のユーザー発言（または選択肢）を反映し、"updates" に矛盾しない状態変化を必ず一つ以上含める。
`;

// ---------- API ----------
app.post('/api/facilitator', async (req, res) => {
  try {
    const { messages, state, selectedChoiceId } = req.body;

    let selectedChoice = null;
    let updates = {};
    
    if (selectedChoiceId) {
      selectedChoice = CHOICES_DATA.choices.find(c => c.id === selectedChoiceId);
      
      if (!selectedChoice) {
        return res.status(400).json({ error: '選択肢が見つかりません' });
      }
      
      if (selectedChoice) {
        updates.scoreDelta = selectedChoice.scoreDelta;
        
        if (selectedChoice.effects.setFlags && selectedChoice.effects.setFlags.length > 0) {
          updates.flags = [...(state.flags || []), ...selectedChoice.effects.setFlags];
        }
        
        if (selectedChoice.effects.addItems && selectedChoice.effects.addItems.length > 0) {
          updates.items = [...(state.items || []), ...selectedChoice.effects.addItems];
        }
        
        if (selectedChoice.effects.customEffect) {
          const customUpdates = handleCustomEffect(selectedChoice.effects.customEffect, state);
          updates = { ...updates, ...customUpdates };
        }
      }
    }

    let next = applySafetyRules(state || {}, updates);

    // Only increment turns when a choice was actually selected
    if (selectedChoiceId) {
      next.totalTurns = (next.totalTurns || 0) + 1;
      next.turnInPhase = (next.turnInPhase || 0) + 1;
      next.turn = next.totalTurns;
      
      // Check if we need to advance to next phase
      if (next.turnInPhase > PHASES[next.currentPhase].turnsInPhase) {
        next.currentPhase++;
        next.turnInPhase = 1;
        next.phaseData.turn1Categories = [];
        
        if (next.familyLocations) {
          next.familyLocations = next.familyLocations.map(x => {
            if (x.location === 'unknown') return { ...x, location: 'home' };
            return x;
          });
        }
      }
    }

    const d = updates?.scoreDelta || {};
    if (d && Object.keys(d).length > 0) {
      Object.keys(d).forEach(key => {
        if (next.scores[key] !== undefined) {
          next.scores[key] = Math.max(0, Math.min(100, next.scores[key] + d[key]));
        }
      });
    }
    
    if (selectedChoice && selectedChoice.effects && selectedChoice.effects.setFlags) {
      for (const flag of selectedChoice.effects.setFlags) {
        if (!next.flags.includes(flag)) {
          next.flags.push(flag);
        }
      }
    }
    
    let predefinedFeedback = '';
    if (selectedChoice) {
      predefinedFeedback = selectedChoice.feedback || selectedChoice.text;
    }
    
    let aiNarration = '';
    if (selectedChoice) {
      const currentPhase = PHASES[next.currentPhase] || PHASES[0];
      const narrationPrompt = `あなたは台風災害シミュレーションゲームのナレーターです。

現在の状況:
- フェーズ: ${currentPhase.name}
- ターン: ${next.turnInPhase}/3
- 警報レベル: ${next.phaseAlertLevel || 'なし'}
- 避難状態: ${next.evac?.status || 'none'}

プレイヤーの行動: ${selectedChoice.text}

30〜120字の短い情景描写を生成してください。音、匂い、光、家族の表情など感覚的な描写を含めてください。
助言や結論は含めないでください。

JSON形式で返してください:
{
  "narration": "ここに描写"
}`;

      try {
        if (client) {
          const r = await client.responses.create({
            model: 'gpt-4o-mini',
            input: [
              { role: 'user', content: narrationPrompt }
            ],
          });

          const output = (r.output_text || '').trim();
          const narrationData = JSON.parse(output);
          aiNarration = narrationData?.narration || '';
        } else {
          aiNarration = '風がうなり、家は小さく軋む。';
        }
      } catch (err) {
        console.error('AIナレーション生成エラー:', err);
        aiNarration = '風がうなり、家は小さく軋む。';
      }
    }
    
    let safeNarr = predefinedFeedback;
    if (aiNarration) {
      safeNarr += '\n\n' + aiNarration;
    }
    
    if (next.specialEvent) {
      safeNarr += `\n\n${next.specialEvent}`;
    }
    
    if (selectedChoiceId && selectedChoice) {
      next.selectedChoiceIds = [...(next.selectedChoiceIds || []), selectedChoiceId];
    }
    
    const availableChoices = filterAvailableChoices(next);
    const choices = selectChoicesByTurn(availableChoices, next.turnInPhase, next);

    const actionText = selectedChoice?.text || '';
    next.story = [...(next.story || []), { 
      turn: next.totalTurns, 
      narration: safeNarr, 
      action: actionText 
    }];

    // 自動終了ガード
    if (next.phase === 'ended' || next.gameEnded) {
      next.phase = 'ended';
    }

    // 結果生成
    let finalReport = null;
    if (next.phase === 'ended') {
      finalReport = await buildFinalReport(next, client);
    }
    
    const phaseInfo = {
      phaseName: PHASES[next.currentPhase]?.name || '終了',
      phaseId: PHASES[next.currentPhase]?.id || 'ended',
      turnInPhase: next.turnInPhase,
      totalTurns: next.totalTurns,
      alertLevel: next.phaseAlertLevel
    };

    res.json({ 
      narration: safeNarr, 
      choices: choices.map(c => ({ id: c.id, text: c.text, category: c.category })), 
      state: next,
      phaseInfo,
      finalReport
    });
  } catch (e) {
    console.error('[AI ERROR]', e?.message || e);
    res.status(500).json({ error: 'AI応答エラー', detail: e?.message || String(e) });
  }
});

async function buildFinalReport(s, client) {
  const scores = s.scores || {
    生存度: 50,
    判断力: 50,
    貢献度: 50,
    準備度: 50,
    文化度: 50
  };

  const weightedScores = {
    生存: scores.生存度 * 0.35,
    判断: scores.判断力 * 0.25,
    準備: scores.準備度 * 0.20,
    貢献: scores.貢献度 * 0.15,
    文化: scores.文化度 * 0.05
  };
  
  const totalScore = Object.values(weightedScores).reduce((a, b) => a + b, 0);
  
  let rank;
  if (totalScore >= 90) rank = 'S（防災マスター）';
  else if (totalScore >= 75) rank = 'A（優秀）';
  else if (totalScore >= 60) rank = 'B（合格）';
  else if (totalScore >= 40) rank = 'C（要改善）';
  else rank = 'D（危険）';

  const actions = s.story?.map(st => st.action).filter(a => a).slice(0, 10) || [];
  
  const reportPrompt = `台風災害シミュレーションゲームの最終評価を生成してください。

スコア:
- 生存度: ${scores.生存度}/100 (重み35%)
- 判断力: ${scores.判断力}/100 (重み25%)
- 準備度: ${scores.準備度}/100 (重み20%)
- 貢献度: ${scores.貢献度}/100 (重み15%)
- 文化度: ${scores.文化度}/100 (重み5%)

総合得点: ${totalScore.toFixed(1)}点
ランク: ${rank}

プレイヤーが選択した主な行動:
${actions.slice(0, 5).map((a, i) => `${i + 1}. ${a}`).join('\n')}

200〜300字程度の評価コメントを生成してください。
良かった点と改善点の両方に触れてください。

JSON形式:
{
  "report": "ここに評価コメント",
  "advice": "次回へのアドバイス（100字程度）"
}`;

  let report = '総合的に良い判断ができました。';
  let advice = '引き続き防災意識を高めていきましょう。';
  
  try {
    if (client) {
      const r = await client.responses.create({
        model: 'gpt-4o-mini',
        input: [
          { role: 'user', content: reportPrompt }
        ],
      });

      const output = (r.output_text || '').trim();
      const reportData = JSON.parse(output);
      report = reportData?.report || report;
      advice = reportData?.advice || advice;
    }
  } catch (err) {
    console.error('最終レポート生成エラー:', err);
  }

  const keyMoments = s.story?.slice(0, 3).map((m) => `・T${m.turn}：${m.narration}`) || [];
  const lastMoments = s.story?.slice(-2).map((m) => `・T${m.turn}：${m.narration}`) || [];

  return {
    headline: s.jma?.special?.length ? '嵐の只中で' : '荒天の夜をこえて',
    summaryBullets: [...keyMoments, '…', ...lastMoments],
    scores,
    weightedScores,
    totalScore: totalScore.toFixed(1),
    rank,
    report,
    advice
  };
}

// ランダム設定をクライアントへ
app.get('/api/new-scenario', (_, res) => res.json({ scenario: generateInitialScenario() }));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Server ready: http://localhost:${PORT}`));
