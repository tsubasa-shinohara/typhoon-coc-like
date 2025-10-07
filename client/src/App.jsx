import { useState, useRef } from 'react';
import axios from 'axios';

export default function App() {
  const [messages, setMessages] = useState([
    { role: 'user', content: '【導入】深夜。大型台風が接近中。自宅は沿岸部。停電の可能性あり。どう動くべき？' }
  ]);
  const [input, setInput] = useState('');
  const [lastRoll, setLastRoll] = useState(null);
  const logRef = useRef(null);

  const send = async () => {
    const newMessages = [...messages, { role: 'user', content: input || '（次の行動を提案して）' }];
    setMessages(newMessages);
    setInput('');

    const res = await axios.post('http://localhost:8787/api/facilitator', {
      messages: newMessages,
      lastRoll
    });

    setMessages(m => [...m, { role: 'assistant', content: res.data.text }]);
    setLastRoll(null); // 使い切り
    setTimeout(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight), 0);
  };

  const rollD100 = () => {
    const n = Math.floor(Math.random() * 100) + 1;
    setLastRoll(n);
  };

  return (
    <div style={{maxWidth: 800, margin: '20px auto', fontFamily: 'system-ui'}}>
      <h1>Typhoon Facilitator (α)</h1>
      <p style={{color:'#555'}}>AIが進行する「大型台風シナリオ」— まずは1人用TRPG風 防災体験</p>

      <div ref={logRef} style={{
        border:'1px solid #ccc', padding:12, height:420, overflowY:'auto', borderRadius:8, background:'#fafafa'
      }}>
        {messages.map((m, i) => (
          <div key={i} style={{marginBottom:14}}>
            <div style={{fontWeight:'bold', color: m.role==='assistant'?'#006b6b':'#333'}}>
              {m.role === 'assistant' ? 'Facilitator' : 'You'}
            </div>
            <div style={{whiteSpace:'pre-wrap'}}>{m.content}</div>
          </div>
        ))}
      </div>

      <div style={{marginTop:12, display:'flex', gap:8}}>
        <input
          value={input}
          onChange={e=>setInput(e.target.value)}
          onKeyDown={(e)=>{ if(e.key==='Enter') send(); }}
          placeholder="行動や質問を入力（例：近所の独居高齢者へ安否確認に行く）"
          style={{flex:1, padding:10, borderRadius:8, border:'1px solid #ccc'}}
        />
        <button onClick={send} style={{padding:'10px 16px'}}>送信</button>
      </div>

      <div style={{marginTop:12, display:'flex', alignItems:'center', gap:8}}>
        <button onClick={rollD100}>d100を振る</button>
        <span>結果: {lastRoll ?? '—'}</span>
        <span style={{color:'#777'}}>（判定の目安に使用。送信すると自動で適用）</span>
      </div>

      <hr style={{margin:'20px 0'}}/>

      <details>
        <summary>使い方のヒント</summary>
        <ul>
          <li>まずは「非常持出袋を確認」「家族の集合場所を決める」などを入力</li>
          <li>d100で運や技能を演出。高いほど危険、低いほど成功…のように活用</li>
          <li>毎ターン、AIが「学びのポイント」を返すので授業の振り返りにも◎</li>
        </ul>
      </details>
    </div>
  );
}
