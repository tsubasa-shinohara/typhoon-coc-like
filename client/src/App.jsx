import { useEffect, useRef, useState } from 'react';
import axios from 'axios';

// ラベル/カラー
const floodLabel = (lv) =>
    ({ none: 'なし', road: '道路冠水', house_1f: '自宅1階が浸水（垂直避難）', house_2f: '自宅2階に到達（救助要請）' }[lv] || lv);

const COLORS = {
    yellow: { bg: '#FFF7CC', border: '#E6D466', text: '#5C4B00' },
    orange: { bg: '#FFE1C4', border: '#E6A46B', text: '#5C2D00' },
    red: { bg: '#FFD2D2', border: '#E67373', text: '#5C0000' },
    green: { bg: '#DFF7DF', border: '#8BD08B', text: '#0F4D0F' },
    blue: { bg: '#E2F0FF', border: '#8ABEF5', text: '#0B3B7A' },
    gray: { bg: '#EEE', border: '#BBB', text: '#333' },
};

const Badge = ({ color = 'gray', children }) => {
    const c = COLORS[color] || COLORS.gray;
    return (
        <span
            style={{
                display: 'inline-block',
                padding: '2px 8px',
                borderRadius: 999,
                border: `1px solid ${c.border}`,
                background: c.bg,
                color: c.text,
                fontSize: 12,
                marginRight: 6,
                marginBottom: 4,
            }}
        >
            {children}
        </span>
    );
};

const AlertBanner = ({ kind, text }) => {
    const map = { 高齢者等避難: 'yellow', 避難指示: 'orange', 緊急安全確保: 'red' };
    const c = COLORS[map[kind] || 'blue'];
    return (
        <div
            role="alert"
            style={{
                border: `2px solid ${c.border}`,
                background: c.bg,
                color: c.text,
                padding: '10px 14px',
                borderRadius: 10,
                marginBottom: 12,
            }}
        >
            <strong style={{ marginRight: 8 }}>エリアメール</strong>
            <Badge color={map[kind] || 'blue'}>{kind || '情報'}</Badge>
            <span>{text}</span>
        </div>
    );
};

export default function App() {
    // ① サーバからランダム設定を取得
    const [scenario, setScenario] = useState(null);
    useEffect(() => {
        (async () => {
            try {
                const r = await axios.get('http://localhost:8787/api/new-scenario');
                setScenario(r.data.scenario);
            } catch {
                setScenario({
                    house: { floors: 2, area: '沿岸部' },
                    timeOfDay: '夜',
                    family: [{ name: 'あなた', role: 'player', location: 'home' }],
                    shelter: '第一小学校 体育館',
                });
            }
        })();
    }, []);

    // ② 状態
    const [messages, setMessages] = useState([]);
    const [phaseInfo, setPhaseInfo] = useState(null);
    const [state, setState] = useState({
        turn: 1,
        currentPhase: 0,
        turnInPhase: 1,
        totalTurns: 0,
        phaseAlertLevel: 'なし',
        powerOutage: false,
        mobileSignal: '通話可',
        floodLevel: 'none',
        jma: { special: [], warnings: [], advisories: [] },
        river: '情報なし',
        evacuationInfo: 'なし',
        landslide: { risk: 'none', info: 'なし', precursors: [] },
        family: 'unknown',
        familyLocations: [],
        alertReceived: false,
        alertType: 'なし',
        phase: 'ongoing',
        scores: { 生存度: 50, 判断力: 50, 貢献度: 50, 準備度: 50, 文化度: 50 },
        story: [],
        finalReport: null,
        scenario: null,
        evac: { status: 'none', route: [], hazards: [], distanceLeft: 100, journeyLog: [] },
        returnETAs: {},
        splitPlans: {},
        currentFloor: 1,
        contactedFamily: {},
        carUse: false,
        neighborOutreach: false,
        routeConfirmed: false,
        items: [],
        flags: [],
        _choices: null,
    });

    const roll = () => Math.floor(Math.random() * 100) + 1;
    const logRef = useRef(null);
    const textRef = useRef(null);

    // ③ シナリオ確定 → 導入文
    useEffect(() => {
        if (!scenario) return;
        const intro = `【導入】遠洋にあった熱帯低気圧が台風にかわったようで、さらに予想進路をみてみると、なんと私の住む地域に直撃するコースのようだ…。今の中心気圧は980hPaで、これからさらに強くなる見込みらしい。しかし、現在の外の様子はとても静かで落ち着いている。まさに嵐の前の静けさ、といった具合だろうか。`;
        
        const initialState = {
            turn: 1,
            currentPhase: 0,
            turnInPhase: 1,
            totalTurns: 0,
            phaseAlertLevel: 'なし',
            powerOutage: false,
            mobileSignal: '通話可',
            floodLevel: 'none',
            jma: { special: [], warnings: [], advisories: [] },
            river: '情報なし',
            evacuationInfo: 'なし',
            landslide: { risk: 'none', info: 'なし', precursors: [] },
            family: 'unknown',
            familyLocations: scenario.family.map((m) => ({ name: m.name, location: m.location })),
            alertReceived: false,
            alertType: 'なし',
            phase: 'ongoing',
            scores: { 生存度: 50, 判断力: 50, 貢献度: 50, 準備度: 50, 文化度: 50 },
            story: [],
            finalReport: null,
            scenario: scenario,
            evac: { status: 'none', route: [], hazards: [], journeyLog: [] },
            returnETAs: {},
            splitPlans: {},
            currentFloor: 1,
            contactedFamily: {},
            carUse: false,
            neighborOutreach: false,
            routeConfirmed: false,
            items: [],
            flags: [],
            _choices: null,
        };
        
        setMessages([{ role: 'assistant', content: intro }]);
        setState(initialState);
        
        (async () => {
            try {
                const res = await axios.post('http://localhost:8787/api/facilitator', {
                    messages: [{ role: 'assistant', content: intro }],
                    lastRoll: null,
                    state: initialState,
                    selectedChoiceId: null,
                });
                const { narration, choices, state: newState, phaseInfo: newPhaseInfo } = res.data;
                
                // Merge newState and choices in one setState to avoid race condition
                if (newState) {
                    setState({ ...newState, _choices: choices || null });
                } else if (choices) {
                    setState((s) => ({ ...s, _choices: choices }));
                }
                
                if (newPhaseInfo) {
                    setPhaseInfo(newPhaseInfo);
                }
                if (narration) {
                    setMessages([{ role: 'assistant', content: intro }, { role: 'assistant', content: narration }]);
                }
            } catch (e) {
                console.error('Failed to fetch initial choices:', e);
            }
        })();
    }, [scenario]);

    // ④ 送信
    const send = async (choice) => {
        if (!choice || !choice.id) {
            console.error('選択肢が必要です');
            return;
        }
        
        const userMsg = { role: 'user', content: choice.text };
        const newMessages = [...messages, userMsg];
        setMessages(newMessages);
        setState(s => ({ ...s, _choices: null }));

        try {
            const res = await axios.post('http://localhost:8787/api/facilitator', {
                messages: newMessages,
                state: { ...state, scenario },
                selectedChoiceId: choice.id,
            });
            const { narration, choices, state: newState, phaseInfo: newPhaseInfo, finalReport } = res.data;
            
            if (narration) {
                setMessages((m) => [...m, { role: 'assistant', content: narration }]);
            }
            
            if (newState) {
                setState({ ...newState, _choices: choices || null });
            }
            
            if (newPhaseInfo) {
                setPhaseInfo(newPhaseInfo);
            }
            
            if (finalReport) {
                setState((s) => ({ ...s, finalReport }));
            }
        } catch (e) {
            console.error('送信エラー:', e);
            setMessages((m) => [...m, { role: 'assistant', content: '（サーバに接続できませんでした）' }]);
        } finally {
            setTimeout(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight), 0);
        }
    };


    // ⑤ バッジ（状況）
    const powerBadge = state.powerOutage ? <Badge color="red">停電</Badge> : <Badge color="green">通電</Badge>;
    const signalBadge =
        state.mobileSignal === '不通' ? <Badge color="red">携帯: 不通</Badge> : <Badge color="green">携帯: 通話可</Badge>;
    const floodBadge = (
        <Badge color={{ none: 'green', road: 'yellow', house_1f: 'orange', house_2f: 'red' }[state.floodLevel] || 'gray'}>
            浸水: {floodLabel(state.floodLevel)}
        </Badge>
    );
    const timeBadge = <Badge color="blue">時刻: {state.scenario?.timeOfDay || '—'}</Badge>;

    // 家族在宅/外出/不明/到着カウント
    // 名簿（設定が正）
    const roster = (state.scenario?.family || []).map(m => m.name);

    // ロケーションマップ（AI更新があれば反映、無ければ 'unknown' 補完）
    const locByName = (() => {
        const map = Object.fromEntries((state.familyLocations || []).map(x => [x.name, x.location]));
        roster.forEach(name => { if (!map[name]) map[name] = 'unknown'; });
        return map;
    })();

    // カウント
    const counts = roster.reduce((acc, name) => {
        const loc = locByName[name];
        acc[loc] = (acc[loc] || 0) + 1;
        return acc;
    }, { home: 0, away: 0, unknown: 0, arrived: 0, en_route: 0 });

    // 外出/不明の詳細（ETAと分散避難の表示に使用）
    const formatAway = name => {
        const eta = state.returnETAs?.[name];
        const plan = state.splitPlans?.[name];
        const etaPart = (typeof eta === 'number' && eta >= 0) ? ` (ETA:${eta})` : '';
        const planPart = plan === 'near_shelter' ? ' →近隣避難所' : '';
        return `${name}${etaPart}${planPart}`;
    };
    const awayNames = roster.filter(n => locByName[n] === 'away').map(formatAway);
    const unknownNames = roster.filter(n => locByName[n] === 'unknown').map(formatAway);

    // バッジ
    const familyBadge = (
        <Badge color="blue">
            家族: 合計{roster.length}
            （在宅{counts.home}・避難中{counts.en_route}・外出{counts.away}・不明{counts.unknown}・到着{counts.arrived}）
            {awayNames.length > 0 ? ` ／外出: ${awayNames.join('、')}` : ''}
            {unknownNames.length > 0 ? ` ／不明: ${unknownNames.join('、')}` : ''}
        </Badge>
    );

    // away / unknown の人だけを ETA 表示対象にする
    const etaPairs = (state.scenario?.family || [])
        .map(m => m.name)
        .filter(name => ['away', 'unknown'].includes((Object.fromEntries((state.familyLocations || []).map(x => [x.name, x.location]))[name]) || 'unknown'))
        .map(name => {
            const eta = state.returnETAs?.[name];
            const plan = state.splitPlans?.[name];
            const location = (Object.fromEntries((state.familyLocations || []).map(x => [x.name, x.location]))[name]) || 'unknown';
            const contacted = state.contactedFamily?.[name] || false;

            const showETA = location === 'away' || contacted;

            const tail = plan === 'near_shelter'
                ? '（近隣避難所へ）'
                : showETA && typeof eta === 'number' ? `（T-${eta}）` : '（T-?）';
            return `${name}${tail}`;
        });

    const etaBadge = etaPairs.length > 0
        ? <Badge color="blue">帰宅ETA: {etaPairs.join('、 ')}</Badge>
        : <Badge color="gray">帰宅ETA: 該当なし</Badge>;

    const evacMap = { none: 'gray', en_route: 'orange', arrived: 'green', aborted: 'red' };
    const evacLabel = (() => {
        const st = state.evac?.status || 'none';
        if (st === 'en_route') {
            const turnsElapsed = state.evac?.turnsElapsed || 0;
            const turnsRequired = state.evac?.turnsRequired || 2;
            return `避難中：あと${Math.max(0, turnsRequired - turnsElapsed)}ターン`;
        }
        if (st === 'arrived') return '避難所に到着';
        if (st === 'aborted') return '避難を中止';
        return `自宅待機中（${state.currentFloor}階）`;
    })();

    const evacBadge = (
        <Badge color={evacMap[state.evac?.status || 'none']}>
            {evacLabel}
        </Badge>
    );

    // JMA バッジカラー関数を先に追加（Badge群の上に）
    const jmaColor = (name) => {
        if (!name) return 'gray';
        if (name.includes('特別警報')) return 'red';
        if (name.includes('警報')) return 'orange';
        if (name.includes('注意報')) return 'yellow';
        return 'gray';
    };

    // --- JMAバッジ ---
    const jmaBadges = [
        ...(state.jma?.special || []).map((n) => (
            <Badge key={`sp-${n}`} color={jmaColor(n)}>
                {n}
            </Badge>
        )),
        ...(state.jma?.warnings || []).map((n) => (
            <Badge key={`wn-${n}`} color={jmaColor(n)}>
                {n}
            </Badge>
        )),
        ...(state.jma?.advisories || []).map((n) => (
            <Badge key={`ad-${n}`} color={jmaColor(n)}>
                {n}
            </Badge>
        )),
    ];
    if (jmaBadges.length === 0) jmaBadges.push(<Badge key="none" color="gray">JMA: なし</Badge>);

    const riverBadge =
        state.river && state.river !== '情報なし' ? (
            <Badge color="orange">河川: {state.river}</Badge>
        ) : (
            <Badge color="blue">河川: 情報なし</Badge>
        );
    const evacInfoBadge = (
        <Badge
            color={{ なし: 'gray', 高齢者等避難: 'yellow', 避難指示: 'orange', 緊急安全確保: 'red' }[state.evacuationInfo] || 'gray'}
        >
            行動情報: {state.evacuationInfo}
        </Badge>
    );

    const slideColor = { none: 'blue', low: 'yellow', medium: 'orange', high: 'red' }[state.landslide?.risk || 'none'];
    const slideBadge = <Badge color={slideColor}>土砂: {state.landslide?.info || 'なし'}</Badge>;

    // ⑥ 結果画面
    if (state.phase === 'ended' && state.finalReport) {
        const r = state.finalReport;
        return (
            <div style={{ maxWidth: 900, margin: '24px auto', fontFamily: 'system-ui' }}>
                <h1>Typhoon Facilitator（結果）</h1>

                <div style={{ marginBottom: 8 }}>
                    {powerBadge}
                    {signalBadge}
                    {floodBadge}
                    {slideBadge}
                    {familyBadge}
                    {timeBadge}
                    {evacBadge}
                </div>

                {state.scenario && (
                    <div style={{ padding: 10, border: '1px solid #ddd', borderRadius: 8, background: '#fff', marginBottom: 10 }}>
                        <strong>設定</strong>：
                        {state.scenario.house.area}の{state.scenario.house.floors}
                        階建て／時刻：{state.scenario.timeOfDay}／家族：
                        {state.scenario.family.map((f) => `${f.name}${f.location === 'unknown' ? '（不明）' : ''}`).join('、')}
                        ／避難先：{state.scenario.shelter}
                    </div>
                )}

                <div style={{ padding: 16, border: '1px solid #ddd', borderRadius: 10, background: '#fafafa', marginBottom: 16 }}>
                    <h2 style={{ marginTop: 0 }}>{r.headline}</h2>
                    <ul style={{ marginTop: 8 }}>
                        {r.summaryBullets.map((t, i) => (
                            <li key={i} style={{ marginBottom: 6 }}>
                                {t}
                            </li>
                        ))}
                    </ul>
                </div>

                <div style={{ padding: 14, border: '1px solid #ddd', borderRadius: 10, background: '#fff', marginBottom: 12 }}>
                    <h3 style={{ marginTop: 0 }}>最終評価: {r.rank}</h3>
                    <div style={{ fontSize: 24, fontWeight: 'bold', color: '#4A90E2', marginBottom: 12 }}>
                        総合得点: {r.totalScore}点
                    </div>
                    
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                        <Badge color="red">{`生存度: ${r.scores.生存度}/100`}</Badge>
                        <Badge color="blue">{`判断力: ${r.scores.判断力}/100`}</Badge>
                        <Badge color="orange">{`準備度: ${r.scores.準備度}/100`}</Badge>
                        <Badge color="green">{`貢献度: ${r.scores.貢献度}/100`}</Badge>
                        <Badge color="purple">{`文化度: ${r.scores.文化度}/100`}</Badge>
                    </div>
                    
                    <div style={{ fontSize: 12, color: '#777', marginTop: 8 }}>
                        重み付けスコア: 生存度×35% + 判断力×25% + 準備度×20% + 貢献度×15% + 文化度×5%
                    </div>
                </div>

                <div style={{ padding: 14, border: '1px solid #ddd', borderRadius: 10, background: '#fff', marginBottom: 12 }}>
                    <h3 style={{ marginTop: 0 }}>評価コメント</h3>
                    <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{r.report}</p>
                </div>

                <div style={{ padding: 14, border: '1px solid #ddd', borderRadius: 10, background: '#fff' }}>
                    <h3 style={{ marginTop: 0 }}>次回へのアドバイス</h3>
                    <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{r.advice}</p>
                </div>
            </div>
        );
    }

    // ⑦ 通常画面
    return (
        <div style={{ maxWidth: 920, margin: '24px auto', fontFamily: 'system-ui' }}>
            <h1>Typhoon Facilitator (Drama＋Landslide＋Evac Route)</h1>

            {/* 設定パネル */}
            {scenario && (
                <div style={{ padding: 10, border: '1px solid #ddd', borderRadius: 8, background: '#fff', marginBottom: 10, fontSize: 14 }}>
                    <strong>設定</strong>：
                    {scenario.house.area}の{scenario.house.floors}
                    階建て／時刻：{scenario.timeOfDay}／家族：
                    {scenario.family.map((f) => `${f.name}${f.location === 'unknown' ? '（不明）' : ''}`).join('、')}
                    ／避難先：{scenario.shelter}
                </div>
            )}

            {/* エリアメール */}
            {state.alertReceived && state.alertType !== 'なし' && (
                <AlertBanner kind={state.alertType} text={`携帯が震える。「${state.alertType}」の一斉送信。`} />
            )}

            {/* ステータス行 */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {phaseInfo && <Badge color="blue">{phaseInfo.phaseName}（{phaseInfo.turnInPhase}/3ターン）</Badge>}
                {powerBadge}
                {signalBadge}
                {floodBadge}
                {slideBadge}
                {familyBadge}
                {timeBadge}
                {evacBadge}
                {etaBadge}
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {jmaBadges}
                {riverBadge}
                {evacInfoBadge}
                {state.landslide?.precursors?.length > 0 && (
                    <Badge color="yellow">前兆: {state.landslide.precursors.join('／')}</Badge>
                )}
                {state.phase === 'clearing' && <Badge color="blue">警戒解除フェーズ（次で終了）</Badge>}
            </div>

            {/* フェーズ情報 */}
            {phaseInfo && (
                <div style={{ padding: 10, border: '2px solid #4A90E2', borderRadius: 8, background: '#E3F2FD', marginBottom: 10, fontSize: 14 }}>
                    <strong>{phaseInfo.phaseName}（{phaseInfo.turnInPhase}/3ターン）</strong>
                    {phaseInfo.alertLevel && phaseInfo.alertLevel !== 'なし' && (
                        <span style={{ marginLeft: 10, color: '#d32f2f' }}>【{phaseInfo.alertLevel}】</span>
                    )}
                </div>
            )}

            {/* スコアゲージ (5軸) */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '8px 0 12px', flexWrap: 'wrap' }}>
                {[
                    { key: '生存度', label: '生存度', weight: 35 },
                    { key: '判断力', label: '判断力', weight: 25 },
                    { key: '準備度', label: '準備度', weight: 20 },
                    { key: '貢献度', label: '貢献度', weight: 15 },
                    { key: '文化度', label: '文化度', weight: 5 }
                ].map(({ key, label, weight }) => {
                    const v = state.scores?.[key] ?? 50;
                    const pct = Math.max(0, Math.min(100, v));
                    return (
                        <div key={key} style={{ flex: 1, minWidth: 120 }}>
                            <div style={{ fontSize: 12, marginBottom: 4, color: '#555' }}>
                                {label} ({weight}%)
                            </div>
                            <div style={{ height: 8, background: '#eee', borderRadius: 8, overflow: 'hidden' }}>
                                <div style={{ width: `${pct}%`, height: '100%', background: '#8ABEF5' }} />
                            </div>
                            <div style={{ fontSize: 11, color: '#777', marginTop: 2 }}>{v}/100</div>
                        </div>
                    );
                })}
            </div>

            {/* ログ */}
            <div
                ref={logRef}
                style={{
                    border: '1px solid #ddd',
                    borderRadius: 10,
                    padding: 12,
                    height: 430,
                    overflowY: 'auto',
                    background: '#fafafa',
                    marginBottom: 8,
                }}
            >
                {messages.map((m, i) => (
                    <div key={i} style={{ marginBottom: 14 }}>
                        <div style={{ fontWeight: 'bold', color: m.role === 'assistant' ? '#006b6b' : '#333' }}>
                            {m.role === 'assistant' ? 'Narration' : 'You'}
                        </div>
                        <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
                    </div>
                ))}
            </div>

            {/* 選択肢パネル（AIが返したら表示） */}
            {Array.isArray(state._choices) && state._choices.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 14, fontWeight: 'bold', marginBottom: 8, color: '#333' }}>
                        行動を選択してください:
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {state._choices.map((c, i) => (
                            <button
                                key={c.id || i}
                                onClick={() => send(c)}
                                style={{ 
                                    padding: '12px 16px', 
                                    borderRadius: 8, 
                                    border: '2px solid #4A90E2', 
                                    background: '#fff',
                                    textAlign: 'left',
                                    cursor: 'pointer',
                                    transition: 'all 0.2s',
                                    fontSize: 14
                                }}
                                onMouseEnter={(e) => {
                                    e.target.style.background = '#E3F2FD';
                                    e.target.style.borderColor = '#1976D2';
                                }}
                                onMouseLeave={(e) => {
                                    e.target.style.background = '#fff';
                                    e.target.style.borderColor = '#4A90E2';
                                }}
                                title={c.category ? `カテゴリー: ${c.category}` : ''}
                            >
                                <strong>{c.text}</strong>
                                {c.category && (
                                    <span style={{ fontSize: 11, color: '#777', marginLeft: 8 }}>
                                        ({c.category})
                                    </span>
                                )}
                            </button>
                        ))}
                    </div>
                </div>
            )}

        </div>
    );
}
