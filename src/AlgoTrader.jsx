import { useState, useEffect, useRef, useCallback } from "react";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PROXY_URL = "https://apex-proxy-production-3908.up.railway.app";

const DEFAULT_WATCHLIST = [
  "AAPL","MSFT","NVDA","TSLA","AMZN","META","GOOGL","AMD","SPY","QQQ",
  "COIN","PLTR","SOFI","MARA","RIOT","SHOP","SQ","HOOD","RBLX","SNAP"
];

const RISK = {
  low:    { pct:0.015, stop:0.015, target:0.03,  max:3,  color:"#00ff87", label:"LOW"  },
  medium: { pct:0.04,  stop:0.03,  target:0.06,  max:5,  color:"#ffbe0b", label:"MED"  },
  high:   { pct:0.08,  stop:0.05,  target:0.15,  max:8,  color:"#ff006e", label:"HIGH" },
};

const SIM_BASE_PRICES = {
  AAPL:185, MSFT:420, NVDA:875, TSLA:195, AMZN:195, META:520, GOOGL:175,
  AMD:160, SPY:535, QQQ:460, COIN:245, PLTR:25, SOFI:8, MARA:18,
  RIOT:12, SHOP:72, SQ:78, HOOD:18, RBLX:42, SNAP:15,
};

// ─── SIMULATION ───────────────────────────────────────────────────────────────
function generateSimBars(basePrice, count = 80) {
  const bars = []; let price = basePrice; let vol = 1000000;
  for (let i = 0; i < count; i++) {
    const change = (Math.random() - 0.48) * price * 0.012;
    const open = price; price = Math.max(1, price + change);
    const high = Math.max(open, price) * (1 + Math.random() * 0.005);
    const low = Math.min(open, price) * (1 - Math.random() * 0.005);
    vol = vol * (0.8 + Math.random() * 0.6);
    bars.push({ o: open, h: high, l: low, c: price, v: Math.floor(vol) });
  }
  return bars;
}

// ─── ALGORITHM ENGINE ─────────────────────────────────────────────────────────
function computeSignals(bars) {
  if (!bars || bars.length < 30) return null;
  const closes = bars.map(b => b.c);
  const highs = bars.map(b => b.h);
  const lows = bars.map(b => b.l);
  const vols = bars.map(b => b.v);
  const last = closes[closes.length - 1];

  const ema = (arr, n) => { const k=2/(n+1); let e=arr[0]; for(let i=1;i<arr.length;i++) e=arr[i]*k+e*(1-k); return e; };

  // RSI(14)
  let gains=0, losses=0;
  for (let i=closes.length-14; i<closes.length; i++) {
    const d=closes[i]-closes[i-1]; if(d>0) gains+=d; else losses-=d;
  }
  const rsi = 100 - 100/(1+(gains/14)/(losses/14||0.001));

  // Bollinger Bands(20)
  const sl=closes.slice(-20), mean=sl.reduce((a,b)=>a+b,0)/20;
  const std=Math.sqrt(sl.reduce((s,x)=>s+(x-mean)**2,0)/20);
  const bbPct=std===0?0.5:(last-(mean-2*std))/(4*std);

  // EMA crossover 9/21
  const ema9=ema(closes.slice(-30),9), ema21=ema(closes.slice(-30),21);
  const emaCross=ema9-ema21;

  // MACD (12,26,9)
  const ema12=ema(closes.slice(-40),12), ema26=ema(closes.slice(-40),26);
  const macdLine=ema12-ema26;
  const macdSignal=ema([...Array(9)].map((_,i)=>ema(closes.slice(-40+i*2),12)-ema(closes.slice(-40+i*2),26)),9);
  const macdHist=macdLine-macdSignal;

  // VWAP approximation
  const vwapBars=bars.slice(-20);
  const vwap=vwapBars.reduce((s,b)=>s+((b.h+b.l+b.c)/3)*b.v,0)/vwapBars.reduce((s,b)=>s+b.v,0);
  const vwapDist=(last-vwap)/vwap*100;

  // ATR(14)
  let atrSum=0;
  for(let i=closes.length-14;i<closes.length;i++)
    atrSum+=Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1]));
  const atr=atrSum/14;

  // Breakout
  const rHigh=Math.max(...highs.slice(-5)), rLow=Math.min(...lows.slice(-5));
  const avgVol=vols.slice(-10).reduce((a,b)=>a+b,0)/10;
  const volSurge=avgVol===0?1:vols[vols.length-1]/avgVol;

  let score=0, reasons=[];

  if(rsi<32&&bbPct<0.2){score+=2;reasons.push({algo:"REVERSION",signal:"BUY",detail:`RSI ${rsi.toFixed(0)} oversold`});}
  else if(rsi>68&&bbPct>0.8){score-=2;reasons.push({algo:"REVERSION",signal:"SELL",detail:`RSI ${rsi.toFixed(0)} overbought`});}

  if(emaCross>last*0.001){score+=1.5;reasons.push({algo:"MOMENTUM",signal:"BUY",detail:`EMA9>EMA21 +${emaCross.toFixed(2)}`});}
  else if(emaCross<-(last*0.001)){score-=1.5;reasons.push({algo:"MOMENTUM",signal:"SELL",detail:`EMA9<EMA21`});}

  if(macdHist>0&&macdLine>0){score+=1.5;reasons.push({algo:"MACD",signal:"BUY",detail:`Hist +${macdHist.toFixed(3)}`});}
  else if(macdHist<0&&macdLine<0){score-=1.5;reasons.push({algo:"MACD",signal:"SELL",detail:`Hist ${macdHist.toFixed(3)}`});}

  if(last>vwap&&vwapDist>0.3){score+=1;reasons.push({algo:"VWAP",signal:"BUY",detail:`+${vwapDist.toFixed(2)}% above`});}
  else if(last<vwap&&vwapDist<-0.3){score-=1;reasons.push({algo:"VWAP",signal:"SELL",detail:`${vwapDist.toFixed(2)}% below`});}

  if(last>rHigh*0.998&&volSurge>1.4){score+=2.5;reasons.push({algo:"BREAKOUT",signal:"BUY",detail:`${volSurge.toFixed(1)}x vol surge`});}
  else if(last<rLow*1.002&&volSurge>1.4){score-=2.5;reasons.push({algo:"BREAKOUT",signal:"SELL",detail:`${volSurge.toFixed(1)}x vol surge`});}

  const maxScore=8.5;
  const confidence=Math.min(1,Math.abs(score)/maxScore);
  const direction=score>1?"BUY":score<-1?"SELL":"NEUTRAL";

  return {
    rsi:rsi.toFixed(1), bbPct:bbPct.toFixed(2), emaCross:emaCross.toFixed(3),
    macdHist:macdHist.toFixed(3), vwapDist:vwapDist.toFixed(2),
    atrPct:(atr/last*100).toFixed(2), volSurge:volSurge.toFixed(2),
    score, confidence, direction, reasons, price:last,
    sparkline: closes.slice(-20),
  };
}

// ─── SPARKLINE ────────────────────────────────────────────────────────────────
function Sparkline({ data, color, width=80, height=28 }) {
  if (!data || data.length < 2) return null;
  const min=Math.min(...data), max=Math.max(...data), range=max-min||1;
  const pts=data.map((v,i)=>`${(i/(data.length-1))*width},${height-((v-min)/range)*height}`).join(" ");
  const isUp=data[data.length-1]>=data[0];
  const c=isUp?"#00ff87":"#ff006e";
  return (
    <svg width={width} height={height} style={{display:"block"}}>
      <polyline points={pts} fill="none" stroke={color||c} strokeWidth="1.5" strokeLinejoin="round"/>
    </svg>
  );
}

// ─── MINI DONUT ───────────────────────────────────────────────────────────────
function Donut({ pct, color, size=44 }) {
  const r=16, circ=2*Math.PI*r, dash=circ*(pct||0);
  return (
    <svg width={size} height={size} viewBox="0 0 44 44">
      <circle cx="22" cy="22" r={r} fill="none" stroke="#1a2535" strokeWidth="4"/>
      <circle cx="22" cy="22" r={r} fill="none" stroke={color} strokeWidth="4"
        strokeDasharray={`${dash} ${circ}`} strokeDashoffset={circ/4}
        strokeLinecap="round" style={{transition:"stroke-dasharray 0.5s"}}/>
      <text x="22" y="26" textAnchor="middle" fill={color} fontSize="10" fontWeight="700" fontFamily="monospace">
        {Math.round((pct||0)*100)}%
      </text>
    </svg>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function AlgoTrader() {
  const [appMode, setAppMode] = useState("sim");
  const [apiKey, setApiKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [riskLevel, setRiskLevel] = useState("low");
  const [connected, setConnected] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [portfolio, setPortfolio] = useState(null);
  const [positions, setPositions] = useState([]);
  const [signals, setSignals] = useState([]);
  const [log, setLog] = useState([]);
  const [watchlist, setWatchlist] = useState(DEFAULT_WATCHLIST);
  const [wlInput, setWlInput] = useState(DEFAULT_WATCHLIST.join(", "));
  const [tab, setTab] = useState("signals");
  const [scanSec, setScanSec] = useState(30);
  const [minConf, setMinConf] = useState(0.4);
  const [autoTrade, setAutoTrade] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [simEquity, setSimEquity] = useState(100000);
  const [simPositions, setSimPositions] = useState([]);
  const [simTrades, setSimTrades] = useState(0);
  const [simPnl, setSimPnl] = useState(0);
  const [tradeHistory, setTradeHistory] = useState([]);
  const [peakEquity, setPeakEquity] = useState(100000);
  const scanRef = useRef(null);
  const countRef = useRef(null);
  const isSim = appMode === "sim";
  const baseUrl = appMode === "paper" ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";
  const dataUrl = "https://data.alpaca.markets";

  const addLog = useCallback((type, msg) => {
    setLog(p => [{ type, msg, ts: new Date().toLocaleTimeString(), id: Date.now()+Math.random() }, ...p].slice(0,300));
  }, []);

  const alpacaFetch = useCallback(async (base, path, opts = {}) => {
    const target = base.includes("data.alpaca") ? "data" : "broker";
    const mode = appMode === "live" ? "live" : "paper";
    const res = await fetch(`${PROXY_URL}/proxy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-apca-api-key-id": apiKey,
        "x-apca-api-secret-key": secretKey,
        "x-alpaca-mode": mode,
      },
      body: JSON.stringify({ target, path, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : undefined }),
    });
    if (!res.ok) { const e=await res.json().catch(()=>({error:res.statusText})); throw new Error(e.message||e.error||res.statusText); }
    return res.json();
  }, [apiKey, secretKey, appMode]);

  const refreshAccount = useCallback(async () => {
    if (isSim) return;
    const [acct, pos] = await Promise.all([alpacaFetch(baseUrl,"/v2/account"), alpacaFetch(baseUrl,"/v2/positions")]);
    setPortfolio(acct); setPositions(pos); return { acct, pos };
  }, [isSim, alpacaFetch, baseUrl]);

  const simPlaceOrder = useCallback((symbol, side, price, risk) => {
    const dollars = simEquity * risk.pct;
    const qty = Math.max(1, Math.floor(dollars / price));
    const stop = side==="buy" ? price*(1-risk.stop) : price*(1+risk.stop);
    const target = side==="buy" ? price*(1+risk.target) : price*(1-risk.target);
    setSimPositions(p => [...p, { symbol, side, qty, entry:price, stop, target, openTime:Date.now() }]);
    setSimEquity(e => e - qty*price);
    setSimTrades(t => t+1);
    addLog("trade", `[SIM] ${side.toUpperCase()} ${qty} ${symbol} @ $${price.toFixed(2)} | Stop $${stop.toFixed(2)} | Target $${target.toFixed(2)}`);
  }, [simEquity, addLog]);

  const simTick = useCallback(() => {
    setSimPositions(prev => {
      const remaining = prev.filter(pos => {
        const base = SIM_BASE_PRICES[pos.symbol]||100;
        const drift = (Math.random()-0.49)*base*0.008;
        const cur = pos.entry + drift;
        const hit = pos.side==="buy" ? (cur>=pos.target||cur<=pos.stop) : (cur<=pos.target||cur>=pos.stop);
        if (hit) {
          const exitPrice = cur>=pos.target ? pos.target : pos.stop;
          const pnl = pos.side==="buy" ? (exitPrice-pos.entry)*pos.qty : (pos.entry-exitPrice)*pos.qty;
          setSimEquity(e => { const ne=e+pos.qty*exitPrice; setPeakEquity(p=>Math.max(p,ne)); return ne; });
          setSimPnl(p => p+pnl);
          setTradeHistory(h => [{
            symbol:pos.symbol, side:pos.side, qty:pos.qty,
            entry:pos.entry, exit:exitPrice, pnl,
            ts:new Date().toLocaleTimeString(), id:Date.now()+Math.random()
          }, ...h].slice(0,100));
          addLog(pnl>=0?"trade":"error", `[SIM] CLOSED ${pos.symbol} P&L: ${pnl>=0?"+":""}$${pnl.toFixed(2)}`);
          return false;
        }
        return true;
      });
      return remaining;
    });
  }, [addLog]);

  const realPlaceOrder = useCallback(async (symbol, side, price, risk) => {
    const { acct } = await refreshAccount();
    const equity = parseFloat(acct.equity);
    const qty = Math.max(1, Math.floor(equity * risk.pct / price));
    const stop = parseFloat((price*(side==="buy"?1-risk.stop:1+risk.stop)).toFixed(2));
    const target = parseFloat((price*(side==="buy"?1+risk.target:1-risk.target)).toFixed(2));
    await alpacaFetch(baseUrl, "/v2/orders", {
      method:"POST",
      body: JSON.stringify({ symbol, qty, side, type:"market", time_in_force:"day",
        order_class:"bracket", stop_loss:{stop_price:stop.toFixed(2)}, take_profit:{limit_price:target.toFixed(2)} }),
    });
    addLog("trade", `${side.toUpperCase()} ${qty} ${symbol} @ ~$${price.toFixed(2)} | Stop $${stop} | Target $${target}`);
  }, [refreshAccount, alpacaFetch, baseUrl, addLog]);

  const runScan = useCallback(async () => {
    const risk = RISK[riskLevel];
    addLog("scan", `Scanning ${watchlist.length} symbols...`);
    const results = [];
    for (const symbol of watchlist) {
      try {
        let bars;
        if (isSim) {
          bars = generateSimBars((SIM_BASE_PRICES[symbol]||100)*(1+(Math.random()-0.5)*0.1));
        } else {
          const end=new Date().toISOString(), start=new Date(Date.now()-2*86400000).toISOString();
          const data=await alpacaFetch(dataUrl,`/v2/stocks/${symbol}/bars?timeframe=5Min&start=${start}&end=${end}&limit=80&feed=iex`);
          bars=data.bars||[];
        }
        const sig=computeSignals(bars);
        if(sig) results.push({symbol,...sig});
      } catch {}
    }
    results.sort((a,b)=>Math.abs(b.score)-Math.abs(a.score));
    setSignals(results);
    if (autoTrade) {
      const openSyms=isSim?simPositions.map(p=>p.symbol):positions.map(p=>p.symbol);
      const actionable=results.filter(s=>s.direction!=="NEUTRAL"&&s.confidence>=minConf&&!openSyms.includes(s.symbol));
      let count=openSyms.length;
      for (const sig of actionable) {
        if(count>=risk.max){addLog("info",`Max positions (${risk.max}) reached`);break;}
        try {
          if(isSim) simPlaceOrder(sig.symbol,sig.direction==="BUY"?"buy":"sell",sig.price,risk);
          else await realPlaceOrder(sig.symbol,sig.direction==="BUY"?"buy":"sell",sig.price,risk);
          count++;
        } catch(e){addLog("error",`${sig.symbol}: ${e.message}`);}
      }
    }
    if(isSim) simTick(); else await refreshAccount().catch(()=>{});
    addLog("scan",`Done. ${results.filter(s=>s.direction!=="NEUTRAL").length} actionable signals.`);
  }, [watchlist,riskLevel,autoTrade,minConf,isSim,simPositions,positions,alpacaFetch,dataUrl,simPlaceOrder,realPlaceOrder,simTick,refreshAccount,addLog]);

  const startScan = useCallback(() => {
    setScanning(true); setCountdown(scanSec); runScan();
    countRef.current=setInterval(()=>setCountdown(c=>c<=1?scanSec:c-1),1000);
    scanRef.current=setInterval(()=>{runScan();setCountdown(scanSec);},scanSec*1000);
  }, [runScan, scanSec]);

  const stopScan = useCallback(() => {
    setScanning(false); clearInterval(scanRef.current); clearInterval(countRef.current);
  }, []);

  useEffect(()=>()=>{clearInterval(scanRef.current);clearInterval(countRef.current);},[]);

  const connect = async () => {
    if (isSim) {
      setConnected(true); setSimEquity(100000); setSimPositions([]); setSimTrades(0); setSimPnl(0);
      setTradeHistory([]); setPeakEquity(100000);
      addLog("info","Simulation started — $100,000 virtual equity"); return;
    }
    try {
      const acct=await alpacaFetch(baseUrl,"/v2/account");
      const pos=await alpacaFetch(baseUrl,"/v2/positions");
      setPortfolio(acct); setPositions(pos); setConnected(true);
      addLog("info",`Connected ${appMode.toUpperCase()} — Equity $${parseFloat(acct.equity).toLocaleString()}`);
    } catch(e){addLog("error",`Connection failed: ${e.message}`);}
  };

  const disconnect = () => { setConnected(false); stopScan(); addLog("info","Disconnected."); };

  // ── DERIVED ───────────────────────────────────────────────────────────────────
  const dispEquity = isSim ? simEquity : (portfolio?parseFloat(portfolio.equity):0);
  const dispPnl = isSim ? simPnl : (portfolio?parseFloat(portfolio.equity)-parseFloat(portfolio.last_equity||portfolio.equity):0);
  const dispPos = isSim ? simPositions : positions;
  const winTrades = tradeHistory.filter(t=>t.pnl>0).length;
  const winRate = tradeHistory.length>0 ? winTrades/tradeHistory.length : 0;
  const maxDD = peakEquity>0 ? Math.max(0,(peakEquity-dispEquity)/peakEquity) : 0;
  const avgWin = tradeHistory.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0)/Math.max(1,winTrades);
  const avgLoss = Math.abs(tradeHistory.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0)/Math.max(1,tradeHistory.length-winTrades));

  const algoColors = { REVERSION:"#a78bfa", MOMENTUM:"#ffbe0b", MACD:"#38bdf8", VWAP:"#fb923c", BREAKOUT:"#00ff87" };
  const algoBg = { REVERSION:"#2e1065", MOMENTUM:"#451a03", MACD:"#0c2a3f", VWAP:"#431407", BREAKOUT:"#052e16" };

  return (
    <div style={S.root}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        ::-webkit-scrollbar{width:3px;height:3px;}
        ::-webkit-scrollbar-track{background:transparent;}
        ::-webkit-scrollbar-thumb{background:#1e3a5f;border-radius:2px;}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
        @keyframes slideIn{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        .pulse{animation:pulse 1.5s infinite;}
        .slide{animation:slideIn 0.2s ease;}
        .fadeup{animation:fadeUp 0.3s ease;}
        button{cursor:pointer;font-family:inherit;}
        input{font-family:inherit;}
        input:focus{outline:none;}
      `}</style>

      {/* ── TOPBAR ── */}
      <header style={S.topbar}>
        <div style={S.brand}>
          <div style={S.brandGem}>◈</div>
          <div>
            <div style={S.brandName}>APEX ALGO</div>
            <div style={S.brandSub}>v2.0 · MULTI-STRATEGY</div>
          </div>
        </div>

        {/* Mode pills */}
        <div style={S.modePills}>
          {[["sim","SIM","#38bdf8"],["paper","PAPER","#a78bfa"],["live","LIVE","#ff006e"]].map(([m,l,c])=>(
            <button key={m} disabled={connected} onClick={()=>{setAppMode(m);setConnected(false);setSignals([]);}}
              style={{...S.pill, ...(appMode===m?{background:c+"22",color:c,borderColor:c,boxShadow:`0 0 12px ${c}33`}:{})}}>
              {m==="live"&&<span style={{color:c,marginRight:4}}>⚡</span>}{l}
            </button>
          ))}
        </div>

        {/* Equity strip */}
        <div style={S.equityStrip}>
          <div style={S.eqItem}>
            <div style={S.eqLabel}>EQUITY</div>
            <div style={S.eqVal}>${dispEquity.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
          </div>
          <div style={S.eqDivider}/>
          <div style={S.eqItem}>
            <div style={S.eqLabel}>P&L</div>
            <div style={{...S.eqVal,color:dispPnl>=0?"#00ff87":"#ff006e"}}>
              {dispPnl>=0?"+":""}{dispPnl.toFixed(2)}
            </div>
          </div>
          <div style={S.eqDivider}/>
          <div style={S.eqItem}>
            <div style={S.eqLabel}>POSITIONS</div>
            <div style={S.eqVal}>{dispPos.length}/{RISK[riskLevel].max}</div>
          </div>
          <div style={S.eqDivider}/>
          <div style={S.eqItem}>
            <div style={S.eqLabel}>WIN RATE</div>
            <div style={{...S.eqVal,color:"#ffbe0b"}}>{tradeHistory.length>0?(winRate*100).toFixed(0):"-"}%</div>
          </div>
        </div>

        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {scanning&&<div style={S.scanBadge}>
            <span className="pulse" style={{color:"#00ff87",fontSize:10}}>●</span>
            <span style={{color:"#64748b",fontSize:11}}>{countdown}s</span>
          </div>}
          <button style={connected?S.btnDanger:S.btnConnect} onClick={connected?disconnect:connect}>
            {connected?"DISCONNECT":"CONNECT"}
          </button>
        </div>
      </header>

      {/* ── CONFIG ── */}
      <div style={S.config}>
        {!isSim&&<>
          <div style={S.cfgField}>
            <div style={S.cfgLbl}>API KEY</div>
            <input style={S.cfgIn} placeholder="PKXXXXXXXXXX" value={apiKey} onChange={e=>setApiKey(e.target.value)} disabled={connected}/>
          </div>
          <div style={S.cfgField}>
            <div style={S.cfgLbl}>SECRET</div>
            <input style={S.cfgIn} type="password" placeholder="••••••••" value={secretKey} onChange={e=>setSecretKey(e.target.value)} disabled={connected}/>
          </div>
          <div style={S.vdiv}/>
        </>}
        <div style={S.cfgField}>
          <div style={S.cfgLbl}>RISK</div>
          <div style={{display:"flex",gap:4}}>
            {Object.entries(RISK).map(([k,v])=>(
              <button key={k} onClick={()=>setRiskLevel(k)}
                style={{...S.riskBtn,...(riskLevel===k?{background:v.color+"22",color:v.color,borderColor:v.color}:{})}}>
                {v.label}
              </button>
            ))}
          </div>
        </div>
        <div style={S.cfgField}>
          <div style={S.cfgLbl}>INTERVAL</div>
          <input style={{...S.cfgIn,width:56}} type="number" min={5} max={300} value={scanSec} onChange={e=>setScanSec(Number(e.target.value))}/>
        </div>
        <div style={S.cfgField}>
          <div style={S.cfgLbl}>MIN CONF</div>
          <input style={{...S.cfgIn,width:56}} type="number" min={0} max={1} step={0.05} value={minConf} onChange={e=>setMinConf(Number(e.target.value))}/>
        </div>
        <div style={S.cfgField}>
          <div style={S.cfgLbl}>WATCHLIST</div>
          <input style={{...S.cfgIn,width:300}} value={wlInput}
            onChange={e=>{setWlInput(e.target.value);setWatchlist(e.target.value.split(",").map(x=>x.trim().toUpperCase()).filter(Boolean));}}/>
        </div>
        <div style={S.vdiv}/>
        <div style={S.cfgField}>
          <div style={S.cfgLbl}>AUTO</div>
          <div style={{...S.toggle,background:autoTrade?"#00ff8722":"#0f172a",borderColor:autoTrade?"#00ff87":"#1e293b"}}
            onClick={()=>setAutoTrade(a=>!a)}>
            <div style={{...S.toggleKnob,transform:autoTrade?"translateX(16px)":"translateX(2px)",background:autoTrade?"#00ff87":"#334155"}}/>
          </div>
        </div>
        <button style={{...S.scanBtn,...(scanning?{background:"#ff006e22",color:"#ff006e",borderColor:"#ff006e"}:{})}}
          disabled={!connected} onClick={scanning?stopScan:startScan}>
          {scanning?"⏹ STOP":"▶ SCAN"}
        </button>
      </div>

      {/* ── BODY ── */}
      <div style={S.body}>

        {/* LEFT: Signal table */}
        <div style={S.leftPane}>
          <div style={S.paneHead}>
            <span style={S.paneTitle}>SIGNAL SCANNER</span>
            <span style={{fontSize:11,color:"#1e3a5f"}}>{watchlist.length} symbols · {signals.filter(s=>s.direction!=="NEUTRAL").length} actionable</span>
          </div>
          <div style={S.tHead}>
            <span style={{width:70}}>SYMBOL</span>
            <span style={{width:72}}>PRICE</span>
            <span style={{width:90}}>CHART</span>
            <span style={{width:52}}>DIR</span>
            <span style={{flex:1}}>ALGOS</span>
            <span style={{width:100}}>SCORE</span>
            <span style={{width:56,textAlign:"right"}}>CONF</span>
          </div>
          <div style={{flex:1,overflowY:"auto"}}>
            {signals.length===0&&<div style={S.empty}>{connected?"Press ▶ SCAN to begin":"Connect to start"}</div>}
            {signals.map(sig=>{
              const sc=sig.score;
              const barColor=sc>1?"#00ff87":sc<-1?"#ff006e":"#334155";
              const dirBg=sig.direction==="BUY"?"#00ff8711":sig.direction==="SELL"?"#ff006e11":"#1e293b";
              const dirColor=sig.direction==="BUY"?"#00ff87":sig.direction==="SELL"?"#ff006e":"#475569";
              return (
                <div key={sig.symbol} className="slide" style={{...S.tRow,borderLeft:`3px solid ${barColor}`}}>
                  <span style={{width:70,fontWeight:700,fontSize:14,color:"#f1f5f9",fontFamily:"Space Grotesk"}}>{sig.symbol}</span>
                  <span style={{width:72,fontSize:12,color:"#64748b",fontFamily:"JetBrains Mono"}}>${sig.price.toFixed(2)}</span>
                  <span style={{width:90}}><Sparkline data={sig.sparkline} width={76} height={26}/></span>
                  <span style={{width:52}}>
                    <span style={{fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:3,background:dirBg,color:dirColor,letterSpacing:"0.08em"}}>
                      {sig.direction}
                    </span>
                  </span>
                  <span style={{flex:1,display:"flex",gap:4,flexWrap:"wrap",alignItems:"center"}}>
                    {sig.reasons.map((r,i)=>(
                      <span key={i} style={{fontSize:9,padding:"2px 6px",borderRadius:3,fontWeight:600,
                        background:algoBg[r.algo]||"#1e293b",color:algoColors[r.algo]||"#64748b",letterSpacing:"0.08em"}}>
                        {r.algo}
                      </span>
                    ))}
                  </span>
                  <span style={{width:100}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <div style={{width:52,height:4,background:"#1e293b",borderRadius:2,overflow:"hidden"}}>
                        <div style={{width:`${Math.min(100,Math.abs(sc)/8.5*100)}%`,height:"100%",background:barColor,borderRadius:2,transition:"width 0.4s"}}/>
                      </div>
                      <span style={{fontSize:11,color:barColor,fontWeight:700,width:28,textAlign:"right",fontFamily:"JetBrains Mono"}}>
                        {sc>0?"+":""}{sc.toFixed(1)}
                      </span>
                    </div>
                  </span>
                  <span style={{width:56,textAlign:"right"}}>
                    <Donut pct={sig.confidence} color={sig.confidence>=minConf?"#ffbe0b":"#1e3a5f"} size={36}/>
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* RIGHT: Tabs */}
        <div style={S.rightPane}>
          <div style={S.tabBar}>
            {[["signals","SIGNALS"],["positions","POSITIONS"],["stats","STATS"],["log","LOG"]].map(([t,l])=>(
              <button key={t} style={{...S.tabBtn,...(tab===t?S.tabActive:{})}} onClick={()=>setTab(t)}>{l}</button>
            ))}
          </div>

          {/* SIGNALS detail */}
          {tab==="signals"&&<div style={S.tabBody}>
            {signals.filter(s=>s.direction!=="NEUTRAL").slice(0,8).map((sig,i)=>(
              <div key={sig.symbol} className="fadeup" style={{...S.sigCard,borderLeft:`3px solid ${sig.direction==="BUY"?"#00ff87":"#ff006e"}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <span style={{fontSize:16,fontWeight:700,color:"#f1f5f9",fontFamily:"Space Grotesk"}}>{sig.symbol}</span>
                    <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:3,
                      background:sig.direction==="BUY"?"#00ff8711":"#ff006e11",
                      color:sig.direction==="BUY"?"#00ff87":"#ff006e"}}>
                      {sig.direction}
                    </span>
                  </div>
                  <Sparkline data={sig.sparkline} width={64} height={24}/>
                </div>
                <div style={{display:"flex",gap:12,marginBottom:8,flexWrap:"wrap"}}>
                  {[["RSI",sig.rsi],["BB",sig.bbPct],["VOL",`${sig.volSurge}x`],["VWAP",`${sig.vwapDist}%`]].map(([k,v])=>(
                    <div key={k} style={{fontSize:10,color:"#475569"}}>
                      <span style={{color:"#1e3a5f"}}>{k} </span><span style={{color:"#94a3b8",fontFamily:"JetBrains Mono"}}>{v}</span>
                    </div>
                  ))}
                </div>
                <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                  {sig.reasons.map((r,j)=>(
                    <span key={j} style={{fontSize:9,padding:"2px 7px",borderRadius:3,fontWeight:600,
                      background:algoBg[r.algo]||"#1e293b",color:algoColors[r.algo]||"#64748b"}}>
                      {r.algo}: {r.detail}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            {signals.filter(s=>s.direction!=="NEUTRAL").length===0&&<div style={S.empty}>No actionable signals yet</div>}
          </div>}

          {/* POSITIONS */}
          {tab==="positions"&&<div style={S.tabBody}>
            {dispPos.length===0?<div style={S.empty}>No open positions</div>:
            dispPos.map((p,i)=>{
              const pl=isSim?((SIM_BASE_PRICES[p.symbol]||p.entry)-p.entry)*p.qty*(p.side==="buy"?1:-1):parseFloat(p.unrealized_pl||0);
              const price=isSim?(SIM_BASE_PRICES[p.symbol]||p.entry):parseFloat(p.current_price||0);
              const pct=isSim?(pl/(p.entry*p.qty)*100):parseFloat(p.unrealized_plpc||0)*100;
              return (
                <div key={i} className="fadeup" style={{...S.posCard,borderLeft:`3px solid ${pl>=0?"#00ff87":"#ff006e"}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                    <div>
                      <span style={{fontSize:16,fontWeight:700,color:"#f1f5f9",fontFamily:"Space Grotesk"}}>{isSim?p.symbol:p.symbol}</span>
                      <span style={{fontSize:11,color:"#334155",marginLeft:8}}>{isSim?p.qty:parseFloat(p.qty)} shares</span>
                      {isSim&&<span style={{fontSize:10,color:"#1e3a5f",marginLeft:6,background:"#1e293b",padding:"1px 6px",borderRadius:3}}>{p.side.toUpperCase()}</span>}
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:15,fontWeight:700,color:pl>=0?"#00ff87":"#ff006e",fontFamily:"JetBrains Mono"}}>
                        {pl>=0?"+":""}${pl.toFixed(2)}
                      </div>
                      <div style={{fontSize:10,color:pl>=0?"#00ff8788":"#ff006e88"}}>{pct>=0?"+":""}{pct.toFixed(2)}%</div>
                    </div>
                  </div>
                  {isSim&&<div style={{display:"flex",gap:16}}>
                    <span style={{fontSize:11,color:"#475569"}}>Entry <span style={{color:"#94a3b8",fontFamily:"JetBrains Mono"}}>${p.entry.toFixed(2)}</span></span>
                    <span style={{fontSize:11,color:"#475569"}}>Stop <span style={{color:"#ff006e",fontFamily:"JetBrains Mono"}}>${p.stop.toFixed(2)}</span></span>
                    <span style={{fontSize:11,color:"#475569"}}>Target <span style={{color:"#00ff87",fontFamily:"JetBrains Mono"}}>${p.target.toFixed(2)}</span></span>
                  </div>}
                </div>
              );
            })}
          </div>}

          {/* STATS */}
          {tab==="stats"&&<div style={S.tabBody}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,padding:"12px 12px 0"}}>
              {[
                {l:"TOTAL TRADES",v:simTrades,c:"#94a3b8"},
                {l:"WIN RATE",v:tradeHistory.length>0?(winRate*100).toFixed(1)+"%":"-",c:"#ffbe0b"},
                {l:"TOTAL P&L",v:(dispPnl>=0?"+":"")+"$"+Math.abs(dispPnl).toFixed(2),c:dispPnl>=0?"#00ff87":"#ff006e"},
                {l:"MAX DRAWDOWN",v:-(maxDD*100).toFixed(1)+"%",c:"#ff006e"},
                {l:"AVG WIN",v:avgWin>0?"$"+avgWin.toFixed(2):"-",c:"#00ff87"},
                {l:"AVG LOSS",v:avgLoss>0?"-$"+avgLoss.toFixed(2):"-",c:"#ff006e"},
              ].map((s,i)=>(
                <div key={i} style={S.statCard}>
                  <div style={{fontSize:9,color:"#1e3a5f",letterSpacing:"0.2em",marginBottom:6}}>{s.l}</div>
                  <div style={{fontSize:20,fontWeight:700,color:s.c,fontFamily:"JetBrains Mono"}}>{s.v}</div>
                </div>
              ))}
            </div>
            <div style={{padding:"12px 12px 0"}}>
              <div style={{fontSize:9,color:"#1e3a5f",letterSpacing:"0.2em",marginBottom:8}}>ALGO DISTRIBUTION</div>
              {Object.entries(algoColors).map(([algo,color])=>{
                const count=tradeHistory.flatMap(()=>[]).length; // placeholder
                const pct=0.2;
                return (
                  <div key={algo} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                    <span style={{fontSize:10,color,width:80,fontWeight:600}}>{algo}</span>
                    <div style={{flex:1,height:4,background:"#1e293b",borderRadius:2}}>
                      <div style={{width:"20%",height:"100%",background:color,borderRadius:2,opacity:0.6}}/>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{padding:"12px"}}>
              <div style={{fontSize:9,color:"#1e3a5f",letterSpacing:"0.2em",marginBottom:8}}>RECENT TRADES</div>
              {tradeHistory.slice(0,6).map((t,i)=>(
                <div key={t.id} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid #0f172a",alignItems:"center"}}>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <span style={{fontSize:12,fontWeight:700,color:"#f1f5f9",fontFamily:"Space Grotesk",width:48}}>{t.symbol}</span>
                    <span style={{fontSize:9,padding:"1px 6px",borderRadius:3,background:t.side==="buy"?"#00ff8711":"#ff006e11",color:t.side==="buy"?"#00ff87":"#ff006e"}}>{t.side.toUpperCase()}</span>
                  </div>
                  <span style={{fontSize:12,fontWeight:700,color:t.pnl>=0?"#00ff87":"#ff006e",fontFamily:"JetBrains Mono"}}>
                    {t.pnl>=0?"+":""}${t.pnl.toFixed(2)}
                  </span>
                </div>
              ))}
              {tradeHistory.length===0&&<div style={{fontSize:11,color:"#1e3a5f",textAlign:"center",padding:16}}>No closed trades yet</div>}
            </div>
          </div>}

          {/* LOG */}
          {tab==="log"&&<div style={{...S.tabBody,gap:0,padding:0}}>
            <div style={{display:"flex",justifyContent:"flex-end",padding:"6px 12px",borderBottom:"1px solid #0a1628"}}>
              <button style={S.clearBtn} onClick={()=>setLog([])}>CLEAR</button>
            </div>
            <div style={{flex:1,overflowY:"auto",padding:8}}>
              {log.length===0&&<div style={S.empty}>No activity</div>}
              {log.map(e=>(
                <div key={e.id} className="slide" style={{display:"flex",gap:8,padding:"4px 2px",borderBottom:"1px solid #0a162888",flexWrap:"wrap",alignItems:"baseline"}}>
                  <span style={{fontSize:10,color:"#1e3a5f",fontFamily:"JetBrains Mono",flexShrink:0}}>{e.ts}</span>
                  <span style={{fontSize:10,fontWeight:700,flexShrink:0,letterSpacing:"0.08em",
                    color:e.type==="trade"?"#00ff87":e.type==="error"?"#ff006e":e.type==="scan"?"#ffbe0b":"#38bdf8"}}>
                    [{e.type.toUpperCase()}]
                  </span>
                  <span style={{fontSize:11,color:"#475569"}}>{e.msg}</span>
                </div>
              ))}
            </div>
          </div>}
        </div>
      </div>

      {/* ── FOOTER ── */}
      <footer style={S.footer}>
        <span style={{color:RISK[riskLevel].color,fontWeight:700,letterSpacing:"0.1em"}}>{RISK[riskLevel].label} RISK</span>
        <span style={{color:"#1e3a5f"}}>·</span>
        <span style={{color:"#334155"}}>{isSim?"🧪 SIMULATION":appMode==="paper"?"📄 PAPER":"⚡ LIVE"}</span>
        <span style={{color:"#1e3a5f"}}>·</span>
        <span style={{color:"#334155"}}>Size {(RISK[riskLevel].pct*100).toFixed(1)}% · Stop {(RISK[riskLevel].stop*100).toFixed(1)}% · Target {(RISK[riskLevel].target*100).toFixed(1)}%</span>
        {isSim&&<><span style={{color:"#1e3a5f"}}>·</span>
        <span>Sim P&L: <span style={{color:simPnl>=0?"#00ff87":"#ff006e",fontFamily:"JetBrains Mono"}}>{simPnl>=0?"+":""}${simPnl.toFixed(2)}</span></span></>}
        <span style={{marginLeft:"auto",color:"#1e3a5f",fontSize:10}}>5 STRATEGIES ACTIVE</span>
      </footer>
    </div>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const S = {
  root:{display:"flex",flexDirection:"column",height:"100vh",background:"#020b14",color:"#cbd5e1",fontFamily:"'JetBrains Mono',monospace",overflow:"hidden"},
  topbar:{display:"flex",alignItems:"center",gap:16,padding:"10px 20px",background:"#050f1c",borderBottom:"1px solid #0a1f35",flexShrink:0},
  brand:{display:"flex",alignItems:"center",gap:10},
  brandGem:{fontSize:22,color:"#00ff87",textShadow:"0 0 20px #00ff8788"},
  brandName:{fontSize:14,fontWeight:700,letterSpacing:"0.2em",color:"#f1f5f9",fontFamily:"Space Grotesk"},
  brandSub:{fontSize:9,color:"#1e3a5f",letterSpacing:"0.25em"},
  modePills:{display:"flex",gap:4},
  pill:{background:"#0a1628",border:"1px solid #1e293b",color:"#475569",padding:"5px 14px",fontSize:10,fontWeight:600,letterSpacing:"0.1em",borderRadius:20,transition:"all 0.2s"},
  equityStrip:{display:"flex",alignItems:"center",gap:0,background:"#050f1c",border:"1px solid #0a1f35",borderRadius:8,overflow:"hidden",marginLeft:"auto"},
  eqItem:{padding:"6px 16px",display:"flex",flexDirection:"column",alignItems:"center"},
  eqDivider:{width:1,background:"#0a1f35",alignSelf:"stretch"},
  eqLabel:{fontSize:8,color:"#1e3a5f",letterSpacing:"0.2em",fontWeight:700,marginBottom:2},
  eqVal:{fontSize:13,fontWeight:700,color:"#e2e8f0",fontFamily:"JetBrains Mono"},
  scanBadge:{display:"flex",alignItems:"center",gap:6,background:"#00ff8711",border:"1px solid #00ff8733",borderRadius:20,padding:"4px 12px"},
  btnConnect:{background:"#00ff8722",border:"1px solid #00ff87",color:"#00ff87",padding:"7px 18px",fontSize:11,fontWeight:600,letterSpacing:"0.1em",borderRadius:6},
  btnDanger:{background:"#ff006e22",border:"1px solid #ff006e",color:"#ff006e",padding:"7px 18px",fontSize:11,fontWeight:600,letterSpacing:"0.1em",borderRadius:6},
  config:{display:"flex",alignItems:"flex-end",gap:14,padding:"8px 20px",background:"#050f1c",borderBottom:"1px solid #0a1f35",flexShrink:0,flexWrap:"wrap"},
  cfgField:{display:"flex",flexDirection:"column",gap:3},
  cfgLbl:{fontSize:8,color:"#1e3a5f",letterSpacing:"0.2em",fontWeight:700},
  cfgIn:{background:"#020b14",border:"1px solid #0a1f35",borderRadius:5,color:"#94a3b8",padding:"5px 9px",fontSize:11},
  vdiv:{width:1,background:"#0a1f35",alignSelf:"stretch",margin:"0 2px"},
  riskBtn:{background:"#020b14",border:"1px solid #0a1f35",borderRadius:4,color:"#334155",padding:"5px 10px",fontSize:9,fontWeight:700,letterSpacing:"0.1em",transition:"all 0.2s"},
  toggle:{width:36,height:20,borderRadius:10,border:"1px solid #1e293b",cursor:"pointer",position:"relative",transition:"all 0.2s"},
  toggleKnob:{position:"absolute",top:2,width:14,height:14,borderRadius:7,transition:"all 0.2s"},
  scanBtn:{background:"#00ff8722",border:"1px solid #00ff8744",color:"#00ff87",padding:"7px 16px",fontSize:11,fontWeight:600,letterSpacing:"0.1em",borderRadius:6,marginLeft:"auto",transition:"all 0.2s"},
  body:{display:"flex",flex:1,minHeight:0},
  leftPane:{flex:1,display:"flex",flexDirection:"column",borderRight:"1px solid #0a1f35",minWidth:0},
  paneHead:{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 16px",background:"#050f1c",borderBottom:"1px solid #0a1f35",flexShrink:0},
  paneTitle:{fontSize:9,letterSpacing:"0.25em",color:"#1e3a5f",fontWeight:700},
  tHead:{display:"flex",gap:8,padding:"6px 16px",background:"#050f1c",borderBottom:"1px solid #0a1f35",fontSize:8,color:"#1e3a5f",letterSpacing:"0.15em",fontWeight:700,flexShrink:0},
  tRow:{display:"flex",alignItems:"center",gap:8,padding:"8px 16px",borderBottom:"1px solid #0a162844",transition:"background 0.15s"},
  rightPane:{width:320,display:"flex",flexDirection:"column",flexShrink:0},
  tabBar:{display:"flex",borderBottom:"1px solid #0a1f35",flexShrink:0},
  tabBtn:{flex:1,padding:"9px 0",background:"transparent",border:"none",color:"#1e3a5f",fontSize:9,fontWeight:700,letterSpacing:"0.12em",borderBottom:"2px solid transparent",transition:"all 0.2s"},
  tabActive:{color:"#00ff87",borderBottom:"2px solid #00ff87"},
  tabBody:{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:0},
  sigCard:{padding:"12px 14px",borderBottom:"1px solid #0a162844"},
  posCard:{padding:"12px 14px",borderBottom:"1px solid #0a162844"},
  statCard:{background:"#050f1c",border:"1px solid #0a1f35",borderRadius:6,padding:"14px 16px"},
  empty:{padding:32,textAlign:"center",color:"#1e3a5f",fontSize:11,letterSpacing:"0.08em"},
  clearBtn:{background:"transparent",border:"1px solid #0a1f35",color:"#1e3a5f",padding:"3px 10px",fontSize:8,letterSpacing:"0.1em",borderRadius:3},
  footer:{display:"flex",gap:10,alignItems:"center",padding:"5px 20px",background:"#050f1c",borderTop:"1px solid #0a1f35",fontSize:10,color:"#334155",flexShrink:0},
};
