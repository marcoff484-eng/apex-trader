import { useState, useEffect, useRef, useCallback } from "react";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const DEFAULT_WATCHLIST = [
  "AAPL","MSFT","NVDA","TSLA","AMZN","META","GOOGL","AMD","SPY","QQQ",
  "COIN","PLTR","SOFI","MARA","RIOT","SHOP","SQ","HOOD","RBLX","SNAP"
];

const RISK = {
  low:    { pct:0.015, stop:0.015, target:0.03,  max:3,  color:"#10b981", label:"LOW"  },
  medium: { pct:0.04,  stop:0.03,  target:0.06,  max:5,  color:"#f59e0b", label:"MED"  },
  high:   { pct:0.08,  stop:0.05,  target:0.15,  max:8,  color:"#ef4444", label:"HIGH" },
};
const PROXY_URL = "apex-proxy-production-3908.up.railway.app"
// ─── SIMULATION: Generate fake OHLCV bars ─────────────────────────────────────
function generateSimBars(basePrice, count = 60) {
  const bars = [];
  let price = basePrice;
  let vol = 1000000;
  for (let i = 0; i < count; i++) {
    const change = (Math.random() - 0.48) * price * 0.012;
    const open  = price;
    price = Math.max(1, price + change);
    const high  = Math.max(open, price) * (1 + Math.random() * 0.005);
    const low   = Math.min(open, price) * (1 - Math.random() * 0.005);
    vol = vol * (0.8 + Math.random() * 0.6);
    bars.push({ o: open, h: high, l: low, c: price, v: Math.floor(vol) });
  }
  return bars;
}

const SIM_BASE_PRICES = {
  AAPL:185, MSFT:420, NVDA:875, TSLA:195, AMZN:195, META:520, GOOGL:175,
  AMD:160, SPY:535, QQQ:460, COIN:245, PLTR:25, SOFI:8, MARA:18,
  RIOT:12, SHOP:72, SQ:78, HOOD:18, RBLX:42, SNAP:15,
};

// ─── ALGORITHM ENGINE ─────────────────────────────────────────────────────────
function computeSignals(bars) {
  if (!bars || bars.length < 22) return null;
  const closes = bars.map(b => b.c);
  const highs  = bars.map(b => b.h);
  const lows   = bars.map(b => b.l);
  const vols   = bars.map(b => b.v);
  const last   = closes[closes.length - 1];

  // RSI(14)
  let gains = 0, losses = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs  = losses === 0 ? 100 : (gains/14) / (losses/14);
  const rsi = 100 - 100 / (1 + rs);

  // Bollinger Bands(20)
  const sl  = closes.slice(-20);
  const mean = sl.reduce((a,b)=>a+b,0)/20;
  const std  = Math.sqrt(sl.reduce((s,x)=>s+(x-mean)**2,0)/20);
  const bbPct = std === 0 ? 0.5 : (last - (mean - 2*std)) / (4*std);

  // EMA crossover 9/21
  const ema = (arr, n) => { const k=2/(n+1); let e=arr[0]; for(let i=1;i<arr.length;i++) e=arr[i]*k+e*(1-k); return e; };
  const ema9  = ema(closes.slice(-30), 9);
  const ema21 = ema(closes.slice(-30), 21);
  const emaCross = ema9 - ema21;

  // ATR(14)
  let atrSum = 0;
  for (let i = closes.length-14; i < closes.length; i++) {
    atrSum += Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
  }
  const atr = atrSum / 14;

  // Breakout
  const rHigh = Math.max(...highs.slice(-5));
  const rLow  = Math.min(...lows.slice(-5));
  const avgVol = vols.slice(-10).reduce((a,b)=>a+b,0)/10;
  const volSurge = avgVol === 0 ? 1 : vols[vols.length-1]/avgVol;

  let score = 0, reasons = [];

  if (rsi < 32 && bbPct < 0.2)       { score += 2;   reasons.push({ algo:"REVERSION", signal:"BUY",  detail:`RSI ${rsi.toFixed(0)} oversold, BB low` }); }
  else if (rsi > 68 && bbPct > 0.8)  { score -= 2;   reasons.push({ algo:"REVERSION", signal:"SELL", detail:`RSI ${rsi.toFixed(0)} overbought, BB high` }); }

  if (emaCross > last*0.001)          { score += 1.5; reasons.push({ algo:"MOMENTUM",  signal:"BUY",  detail:`EMA9 > EMA21 +${emaCross.toFixed(2)}` }); }
  else if (emaCross < -(last*0.001))  { score -= 1.5; reasons.push({ algo:"MOMENTUM",  signal:"SELL", detail:`EMA9 < EMA21 -${Math.abs(emaCross).toFixed(2)}` }); }

  if (last > rHigh*0.998 && volSurge > 1.4) { score += 2.5; reasons.push({ algo:"BREAKOUT", signal:"BUY",  detail:`5-bar high break, ${volSurge.toFixed(1)}x vol` }); }
  else if (last < rLow*1.002 && volSurge > 1.4) { score -= 2.5; reasons.push({ algo:"BREAKOUT", signal:"SELL", detail:`5-bar low break, ${volSurge.toFixed(1)}x vol` }); }

  const confidence = Math.min(1, Math.abs(score) / 6);
  const direction  = score > 1 ? "BUY" : score < -1 ? "SELL" : "NEUTRAL";

  return { rsi:rsi.toFixed(1), bbPct:bbPct.toFixed(2), emaCross:emaCross.toFixed(3),
    atrPct:(atr/last*100).toFixed(2), volSurge:volSurge.toFixed(2),
    score, confidence, direction, reasons, price: last };
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function AlgoTrader() {
  const [appMode, setAppMode]         = useState("sim");   // "sim" | "paper" | "live"
  const [apiKey, setApiKey]           = useState("");
  const [secretKey, setSecretKey]     = useState("");
  const [riskLevel, setRiskLevel]     = useState("low");
  const [connected, setConnected]     = useState(false);
  const [scanning, setScanning]       = useState(false);
  const [portfolio, setPortfolio]     = useState(null);
  const [positions, setPositions]     = useState([]);
  const [signals, setSignals]         = useState([]);
  const [log, setLog]                 = useState([]);
  const [watchlist, setWatchlist]     = useState(DEFAULT_WATCHLIST);
  const [wlInput, setWlInput]         = useState(DEFAULT_WATCHLIST.join(", "));
  const [tab, setTab]                 = useState("signals"); // signals | positions | log
  const [scanSec, setScanSec]         = useState(30);
  const [minConf, setMinConf]         = useState(0.4);
  const [autoTrade, setAutoTrade]     = useState(false);
  const [countdown, setCountdown]     = useState(0);
  const [simEquity, setSimEquity]     = useState(100000);
  const [simPositions, setSimPositions] = useState([]);
  const [simTrades, setSimTrades]     = useState(0);
  const [simPnl, setSimPnl]           = useState(0);
  const scanRef  = useRef(null);
  const countRef = useRef(null);

  const isSim = appMode === "sim";
  const baseUrl = appMode === "paper" ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";
  const dataUrl = "https://data.alpaca.markets";

  const addLog = useCallback((type, msg) => {
    setLog(p => [{ type, msg, ts: new Date().toLocaleTimeString(), id: Date.now()+Math.random() }, ...p].slice(0,200));
  }, []);

  const alpacaFetch = useCallback(async (base, path, opts = {}) => {
    const target = base.includes("data.alpaca") ? "data" : "broker";
    const mode   = appMode === "live" ? "live" : "paper";

    const res = await fetch(`${PROXY_URL}/proxy`, {
      method: "POST",
      headers: {
        "Content-Type":          "application/json",
        "x-apca-api-key-id":     apiKey,
        "x-apca-api-secret-key": secretKey,
        "x-alpaca-mode":         mode,
      },
      body: JSON.stringify({
        target,
        path,
        method: opts.method || "GET",
        body:   opts.body ? JSON.parse(opts.body) : undefined,
      }),
    });

    if (!res.ok) {
      const e = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(e.message || e.error || res.statusText);
    }
    return res.json();
  }, [apiKey, secretKey, appMode]);

  const refreshAccount = useCallback(async () => {
    if (isSim) return;
    const [acct, pos] = await Promise.all([alpacaFetch(baseUrl,"/v2/account"), alpacaFetch(baseUrl,"/v2/positions")]);
    setPortfolio(acct); setPositions(pos);
    return { acct, pos };
  }, [isSim, alpacaFetch, baseUrl]);

  // ── SIM: place a virtual bracket order ───────────────────────────────────────
  const simPlaceOrder = useCallback((symbol, side, price, risk) => {
    const equity  = simEquity;
    const dollars = equity * risk.pct;
    const qty     = Math.max(1, Math.floor(dollars / price));
    const stop    = side === "buy" ? price*(1-risk.stop)   : price*(1+risk.stop);
    const target  = side === "buy" ? price*(1+risk.target) : price*(1-risk.target);
    const pos = { symbol, side, qty, entry: price, stop, target, openTime: Date.now() };
    setSimPositions(p => [...p, pos]);
    setSimEquity(e => e - qty*price);
    setSimTrades(t => t+1);
    addLog("trade", `[SIM] ${side.toUpperCase()} ${qty} ${symbol} @ $${price.toFixed(2)} | Stop $${stop.toFixed(2)} | Target $${target.toFixed(2)}`);
  }, [simEquity, addLog]);

  // ── SIM: tick prices and close positions ─────────────────────────────────────
  const simTick = useCallback(() => {
    setSimPositions(prev => {
      let newPnl = 0;
      const remaining = prev.filter(pos => {
        const base  = SIM_BASE_PRICES[pos.symbol] || 100;
        const drift = (Math.random()-0.49)*base*0.008;
        const cur   = pos.entry + drift;
        const hit   = pos.side==="buy" ? (cur >= pos.target || cur <= pos.stop) : (cur <= pos.target || cur >= pos.stop);
        if (hit) {
          const exitPrice = cur >= pos.target ? pos.target : pos.stop;
          const pnl = pos.side==="buy" ? (exitPrice-pos.entry)*pos.qty : (pos.entry-exitPrice)*pos.qty;
          newPnl += pnl;
          setSimEquity(e => e + pos.qty*exitPrice);
          setSimPnl(p => p + pnl);
          addLog(pnl>=0 ? "trade" : "error", `[SIM] CLOSED ${pos.symbol} P&L: ${pnl>=0?"+":""}$${pnl.toFixed(2)}`);
          return false;
        }
        return true;
      });
      return remaining;
    });
  }, [addLog]);

  // ── REAL: place bracket order ─────────────────────────────────────────────────
  const realPlaceOrder = useCallback(async (symbol, side, price, risk) => {
    const { acct } = await refreshAccount();
    const equity   = parseFloat(acct.equity);
    const qty      = Math.max(1, Math.floor(equity * risk.pct / price));
    const stop     = parseFloat((price * (side==="buy" ? 1-risk.stop : 1+risk.stop)).toFixed(2));
    const target   = parseFloat((price * (side==="buy" ? 1+risk.target : 1-risk.target)).toFixed(2));
    await alpacaFetch(baseUrl, "/v2/orders", {
      method:"POST",
      body: JSON.stringify({ symbol, qty, side, type:"market", time_in_force:"day",
        order_class:"bracket", stop_loss:{stop_price:stop.toFixed(2)}, take_profit:{limit_price:target.toFixed(2)} }),
    });
    addLog("trade", `${side.toUpperCase()} ${qty} ${symbol} @ ~$${price.toFixed(2)} | Stop $${stop} | Target $${target}`);
  }, [refreshAccount, alpacaFetch, baseUrl, addLog]);

  // ── SCAN ─────────────────────────────────────────────────────────────────────
  const runScan = useCallback(async () => {
    const risk = RISK[riskLevel];
    addLog("scan", `Scanning ${watchlist.length} symbols...`);
    const results = [];

    for (const symbol of watchlist) {
      try {
        let bars;
        if (isSim) {
          const base = SIM_BASE_PRICES[symbol] || 100;
          bars = generateSimBars(base + (Math.random()-0.5)*base*0.1);
        } else {
          const end   = new Date().toISOString();
          const start = new Date(Date.now()-2*86400000).toISOString();
          const data  = await alpacaFetch(dataUrl, `/v2/stocks/${symbol}/bars?timeframe=5Min&start=${start}&end=${end}&limit=60&feed=iex`);
          bars = data.bars || [];
        }
        const sig = computeSignals(bars);
        if (sig) results.push({ symbol, ...sig });
      } catch { /* skip */ }
    }

    results.sort((a,b) => Math.abs(b.score)-Math.abs(a.score));
    setSignals(results);

    if (autoTrade) {
      const openSyms = isSim ? simPositions.map(p=>p.symbol) : positions.map(p=>p.symbol);
      const actionable = results.filter(s => s.direction!=="NEUTRAL" && s.confidence>=minConf && !openSyms.includes(s.symbol));
      let count = openSyms.length;
      for (const sig of actionable) {
        if (count >= risk.max) { addLog("info",`Max positions (${risk.max}) reached`); break; }
        const side = sig.direction==="BUY" ? "buy" : "sell";
        try {
          if (isSim) simPlaceOrder(sig.symbol, side, sig.price, risk);
          else await realPlaceOrder(sig.symbol, side, sig.price, risk);
          count++;
        } catch(e) { addLog("error", `${sig.symbol}: ${e.message}`); }
      }
    }

    if (isSim) simTick();
    else await refreshAccount().catch(()=>{});
    addLog("scan", `Done. ${results.filter(s=>s.direction!=="NEUTRAL").length} actionable signals.`);
  }, [watchlist, riskLevel, autoTrade, minConf, isSim, simPositions, positions, alpacaFetch, dataUrl, simPlaceOrder, realPlaceOrder, simTick, refreshAccount, addLog]);

  const startScan = useCallback(() => {
    setScanning(true); setCountdown(scanSec); runScan();
    countRef.current = setInterval(() => setCountdown(c => c<=1 ? scanSec : c-1), 1000);
    scanRef.current  = setInterval(() => { runScan(); setCountdown(scanSec); }, scanSec*1000);
  }, [runScan, scanSec]);

  const stopScan = useCallback(() => {
    setScanning(false);
    clearInterval(scanRef.current); clearInterval(countRef.current);
  }, []);

  useEffect(() => () => { clearInterval(scanRef.current); clearInterval(countRef.current); }, []);

  const connect = async () => {
    if (isSim) {
      setConnected(true);
      setSimEquity(100000); setSimPositions([]); setSimTrades(0); setSimPnl(0);
      addLog("info","Simulation started — $100,000 virtual equity");
      return;
    }
    try {
      const acct = await alpacaFetch(baseUrl, "/v2/account");
      const pos  = await alpacaFetch(baseUrl, "/v2/positions");
      setPortfolio(acct); setPositions(pos); setConnected(true);
      addLog("info", `Connected ${appMode.toUpperCase()} — Equity $${parseFloat(acct.equity).toLocaleString()}`);
    } catch(e) { addLog("error", `Connection failed: ${e.message}`); }
  };

  const disconnect = () => { setConnected(false); stopScan(); addLog("info","Disconnected."); };

  // ── DERIVED DISPLAY ───────────────────────────────────────────────────────────
  const dispEquity   = isSim ? simEquity : (portfolio ? parseFloat(portfolio.equity) : 0);
  const dispPnl      = isSim ? simPnl    : (portfolio ? parseFloat(portfolio.equity)-parseFloat(portfolio.last_equity||portfolio.equity) : 0);
  const dispPos      = isSim ? simPositions : positions;
  const dispPosCount = dispPos.length;

  const scoreColor = s => s > 1 ? "#10b981" : s < -1 ? "#ef4444" : "#6b7280";

  return (
    <div style={css.root}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: #0f172a; } ::-webkit-scrollbar-thumb { background: #1e3a5f; border-radius: 2px; }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:translateY(0)} }
        .blink { animation: blink 1.4s infinite; }
        .fadein { animation: fadeIn 0.25s ease; }
        button:hover { opacity: 0.85; }
        input:focus { border-color: #3b82f6 !important; outline: none; }
      `}</style>

      {/* ── TOP BAR ── */}
      <div style={css.topbar}>
        <div style={css.brand}>
          <div style={css.brandIcon}>◈</div>
          <div>
            <div style={css.brandName}>APEX ALGO</div>
            <div style={css.brandSub}>MULTI-STRATEGY ENGINE</div>
          </div>
        </div>

        {/* Mode Selector */}
        <div style={css.modeGroup}>
          {[["sim","🧪 SIM"],["paper","📄 PAPER"],["live","⚡ LIVE"]].map(([m,label]) => (
            <button key={m} disabled={connected}
              style={{ ...css.modeBtn, ...(appMode===m ? css.modeBtnActive : {}),
                ...(appMode===m && m==="live" ? {background:"#7f1d1d",color:"#fca5a5",borderColor:"#ef4444"} : {}),
                ...(appMode===m && m==="sim"  ? {background:"#1e3a5f",color:"#60a5fa",borderColor:"#3b82f6"} : {}),
              }}
              onClick={() => { setAppMode(m); setConnected(false); setSignals([]); }}>
              {label}
            </button>
          ))}
        </div>

        {/* Stats */}
        <div style={css.stats}>
          <div style={css.stat}>
            <div style={css.statLabel}>EQUITY</div>
            <div style={css.statVal}>${dispEquity.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
          </div>
          <div style={css.stat}>
            <div style={css.statLabel}>DAY P&L</div>
            <div style={{...css.statVal, color: dispPnl>=0?"#10b981":"#ef4444"}}>
              {dispPnl>=0?"+":""} ${dispPnl.toFixed(2)}
            </div>
          </div>
          <div style={css.stat}>
            <div style={css.statLabel}>POSITIONS</div>
            <div style={css.statVal}>{dispPosCount} / {RISK[riskLevel].max}</div>
          </div>
          {isSim && <div style={css.stat}>
            <div style={css.statLabel}>SIM TRADES</div>
            <div style={css.statVal}>{simTrades}</div>
          </div>}
        </div>

        {/* Status + Connect */}
        <div style={{ display:"flex", gap:10, alignItems:"center" }}>
          {connected && scanning && (
            <div style={css.scanStatus}>
              <span className="blink" style={{color:"#10b981"}}>●</span>
              <span style={{color:"#6b7280",fontSize:12}}>next in {countdown}s</span>
            </div>
          )}
          <button style={connected ? css.btnDanger : css.btnPrimary} onClick={connected ? disconnect : connect}>
            {connected ? "DISCONNECT" : "CONNECT"}
          </button>
        </div>
      </div>

      {/* ── CONFIG BAR ── */}
      <div style={css.configBar}>
        {/* API keys — hide in sim */}
        {!isSim && (
          <>
            <div style={css.cfgGroup}>
              <label style={css.cfgLabel}>API KEY</label>
              <input style={css.cfgInput} placeholder="PKXXXXXXXXXX" value={apiKey} onChange={e=>setApiKey(e.target.value)} disabled={connected} />
            </div>
            <div style={css.cfgGroup}>
              <label style={css.cfgLabel}>SECRET</label>
              <input style={css.cfgInput} type="password" placeholder="••••••••••••" value={secretKey} onChange={e=>setSecretKey(e.target.value)} disabled={connected} />
            </div>
            <div style={css.divider} />
          </>
        )}
        <div style={css.cfgGroup}>
          <label style={css.cfgLabel}>RISK</label>
          <div style={{ display:"flex", gap:4 }}>
            {Object.entries(RISK).map(([k,v]) => (
              <button key={k} style={{...css.smBtn, ...(riskLevel===k?{background:v.color+"22",color:v.color,borderColor:v.color}:{})}}
                onClick={()=>setRiskLevel(k)}>{v.label}</button>
            ))}
          </div>
        </div>
        <div style={css.cfgGroup}>
          <label style={css.cfgLabel}>SCAN (SEC)</label>
          <input style={{...css.cfgInput,width:60}} type="number" min={5} max={300} value={scanSec} onChange={e=>setScanSec(Number(e.target.value))} />
        </div>
        <div style={css.cfgGroup}>
          <label style={css.cfgLabel}>MIN CONF</label>
          <input style={{...css.cfgInput,width:60}} type="number" min={0} max={1} step={0.05} value={minConf} onChange={e=>setMinConf(Number(e.target.value))} />
        </div>
        <div style={css.cfgGroup}>
          <label style={css.cfgLabel}>WATCHLIST</label>
          <input style={{...css.cfgInput,width:320}} value={wlInput}
            onChange={e=>{ setWlInput(e.target.value); setWatchlist(e.target.value.split(",").map(x=>x.trim().toUpperCase()).filter(Boolean)); }} />
        </div>
        <div style={css.divider} />
        <div style={css.cfgGroup}>
          <label style={css.cfgLabel}>AUTO-TRADE</label>
          <label style={css.toggle}>
            <input type="checkbox" checked={autoTrade} onChange={e=>setAutoTrade(e.target.checked)} style={{display:"none"}} />
            <div style={{...css.toggleTrack, background: autoTrade?"#10b981":"#1e293b"}}>
              <div style={{...css.toggleThumb, transform: autoTrade?"translateX(18px)":"translateX(2px)"}} />
            </div>
          </label>
        </div>
        <button style={{...css.btnPrimary, ...(scanning?css.btnDanger:{}), marginLeft:"auto"}}
          disabled={!connected} onClick={scanning?stopScan:startScan}>
          {scanning ? "⏹ STOP" : "▶ START SCAN"}
        </button>
      </div>

      {/* ── MAIN BODY ── */}
      <div style={css.body}>

        {/* LEFT: Signal Table */}
        <div style={css.leftPanel}>
          <div style={css.panelHead}>
            <span style={css.panelTitle}>SIGNAL SCANNER — {watchlist.length} SYMBOLS</span>
            <span style={{fontSize:12,color:"#4b5563"}}>{signals.filter(s=>s.direction!=="NEUTRAL").length} actionable</span>
          </div>

          {/* Column Headers */}
          <div style={css.tableHead}>
            <span style={{width:72}}>SYMBOL</span>
            <span style={{width:60}}>PRICE</span>
            <span style={{width:56}}>SIGNAL</span>
            <span style={{flex:1}}>ALGORITHMS</span>
            <span style={{width:80}}>SCORE</span>
            <span style={{width:64,textAlign:"right"}}>CONF</span>
          </div>

          <div style={css.tableBody}>
            {signals.length===0 && (
              <div style={css.emptyState}>
                {connected ? "Press ▶ START SCAN to begin" : "Connect to start"}
              </div>
            )}
            {signals.map(sig => (
              <div key={sig.symbol} className="fadein" style={{
                ...css.tableRow,
                borderLeft: `3px solid ${scoreColor(sig.score)}`,
              }}>
                <span style={{width:72,fontWeight:700,fontSize:15,color:"#f1f5f9",fontFamily:"'Inter',sans-serif"}}>{sig.symbol}</span>
                <span style={{width:60,fontSize:13,color:"#94a3b8"}}>${sig.price.toFixed(2)}</span>
                <span style={{width:56}}>
                  <span style={{
                    fontSize:11, fontWeight:700, padding:"2px 7px", borderRadius:4,
                    background: sig.direction==="BUY"?"#064e3b":sig.direction==="SELL"?"#7f1d1d":"#1e293b",
                    color: sig.direction==="BUY"?"#10b981":sig.direction==="SELL"?"#ef4444":"#6b7280",
                  }}>{sig.direction}</span>
                </span>
                <span style={{flex:1,display:"flex",gap:5,flexWrap:"wrap",alignItems:"center"}}>
                  {sig.reasons.map((r,i)=>(
                    <span key={i} style={{
                      fontSize:10,padding:"1px 6px",borderRadius:3,fontWeight:600,
                      background: r.algo==="REVERSION"?"#4c1d95":r.algo==="MOMENTUM"?"#78350f":"#064e3b",
                      color: r.algo==="REVERSION"?"#c4b5fd":r.algo==="MOMENTUM"?"#fcd34d":"#6ee7b7",
                    }}>{r.algo}</span>
                  ))}
                  {sig.reasons.length===0 && <span style={{fontSize:11,color:"#374151"}}>—</span>}
                </span>
                <span style={{width:80}}>
                  <div style={{display:"flex",alignItems:"center",gap:5}}>
                    <div style={{width:48,height:5,background:"#1e293b",borderRadius:3,overflow:"hidden"}}>
                      <div style={{width:`${Math.min(100,Math.abs(sig.score)/6*100)}%`,height:"100%",background:scoreColor(sig.score),borderRadius:3}} />
                    </div>
                    <span style={{fontSize:11,color:scoreColor(sig.score),fontWeight:700,width:24,textAlign:"right"}}>
                      {sig.score>0?"+":""}{sig.score.toFixed(1)}
                    </span>
                  </div>
                </span>
                <span style={{width:64,textAlign:"right",fontSize:13,fontWeight:600,color:sig.confidence>=minConf?"#f59e0b":"#374151"}}>
                  {(sig.confidence*100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT: Tabs */}
        <div style={css.rightPanel}>
          <div style={css.tabs}>
            {[["positions","POSITIONS"],["strategies","STRATEGIES"],["log","LOG"]].map(([t,l])=>(
              <button key={t} style={{...css.tab,...(tab===t?css.tabActive:{})}} onClick={()=>setTab(t)}>{l}</button>
            ))}
          </div>

          {tab==="positions" && (
            <div style={css.tabContent}>
              {dispPos.length===0 ? (
                <div style={css.emptyState}>No open positions</div>
              ) : dispPos.map((p,i) => {
                const sym   = isSim ? p.symbol : p.symbol;
                const qty   = isSim ? p.qty    : parseFloat(p.qty);
                const pl    = isSim
                  ? ((SIM_BASE_PRICES[p.symbol]||p.entry) - p.entry) * p.qty * (p.side==="buy"?1:-1)
                  : parseFloat(p.unrealized_pl);
                const price = isSim ? (SIM_BASE_PRICES[p.symbol]||p.entry) : parseFloat(p.current_price);
                return (
                  <div key={i} style={css.posCard}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                      <div>
                        <span style={{fontSize:16,fontWeight:700,color:"#f1f5f9",fontFamily:"Inter"}}>{sym}</span>
                        <span style={{fontSize:12,color:"#4b5563",marginLeft:8}}>{qty} shares {isSim&&`· ${p.side.toUpperCase()}`}</span>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:15,fontWeight:700,color:pl>=0?"#10b981":"#ef4444"}}>
                          {pl>=0?"+":""}${pl.toFixed(2)}
                        </div>
                        <div style={{fontSize:12,color:"#6b7280"}}>${price.toFixed(2)}</div>
                      </div>
                    </div>
                    {isSim && (
                      <div style={{display:"flex",gap:12,marginTop:6}}>
                        <span style={{fontSize:11,color:"#6b7280"}}>Entry <span style={{color:"#94a3b8"}}>${p.entry.toFixed(2)}</span></span>
                        <span style={{fontSize:11,color:"#6b7280"}}>Stop <span style={{color:"#ef4444"}}>${p.stop.toFixed(2)}</span></span>
                        <span style={{fontSize:11,color:"#6b7280"}}>Target <span style={{color:"#10b981"}}>${p.target.toFixed(2)}</span></span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {tab==="strategies" && (
            <div style={css.tabContent}>
              {[
                { name:"MEAN REVERSION", weight:"2.0", color:"#a78bfa", bg:"#4c1d95",
                  detail:"Uses RSI(14) and Bollinger Bands(20). Buys when RSI < 32 and price is near the lower band. Sells when RSI > 68 and price is near the upper band." },
                { name:"MOMENTUM", weight:"1.5", color:"#fcd34d", bg:"#78350f",
                  detail:"EMA 9/21 crossover. Enters long when the 9-period EMA crosses above the 21-period EMA, and short when it crosses below." },
                { name:"VOL BREAKOUT", weight:"2.5", color:"#6ee7b7", bg:"#064e3b",
                  detail:"ATR-based breakout detector. Triggers when price breaks the 5-bar high/low and volume is 1.4× above the 10-bar average." },
              ].map(st => (
                <div key={st.name} style={{...css.stratCard, borderLeft:`3px solid ${st.color}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                    <span style={{fontSize:13,fontWeight:700,color:st.color,fontFamily:"Inter"}}>{st.name}</span>
                    <span style={{fontSize:11,color:"#4b5563",background:st.bg,padding:"2px 8px",borderRadius:4}}>weight {st.weight}</span>
                  </div>
                  <p style={{fontSize:12,color:"#6b7280",lineHeight:1.6}}>{st.detail}</p>
                </div>
              ))}
              <div style={{...css.stratCard,borderLeft:"3px solid #3b82f6",marginTop:4}}>
                <div style={{fontSize:13,fontWeight:700,color:"#60a5fa",fontFamily:"Inter",marginBottom:6}}>SCORING SYSTEM</div>
                <p style={{fontSize:12,color:"#6b7280",lineHeight:1.6}}>
                  Signals are scored on a -6 to +6 scale (sum of all algorithm weights).
                  A score above +1 triggers BUY, below -1 triggers SELL.
                  Confidence = |score| / 6. Only signals above your Min Confidence threshold are auto-traded.
                </p>
              </div>
            </div>
          )}

          {tab==="log" && (
            <div style={{...css.tabContent, gap:0}}>
              <div style={{display:"flex",justifyContent:"flex-end",padding:"6px 12px",borderBottom:"1px solid #0f172a"}}>
                <button style={css.clearBtn} onClick={()=>setLog([])}>CLEAR</button>
              </div>
              <div style={{flex:1,overflowY:"auto",padding:8}}>
                {log.length===0 && <div style={css.emptyState}>No activity</div>}
                {log.map(e => (
                  <div key={e.id} className="fadein" style={{display:"flex",gap:8,padding:"4px 4px",borderBottom:"1px solid #0f172a08",alignItems:"baseline",flexWrap:"wrap"}}>
                    <span style={{fontSize:11,color:"#1e3a5f",flexShrink:0,fontFamily:"JetBrains Mono"}}>{e.ts}</span>
                    <span style={{fontSize:11,fontWeight:700,flexShrink:0,
                      color:e.type==="trade"?"#10b981":e.type==="error"?"#ef4444":e.type==="scan"?"#f59e0b":"#3b82f6"}}>
                      [{e.type.toUpperCase()}]
                    </span>
                    <span style={{fontSize:12,color:"#475569"}}>{e.msg}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── FOOTER ── */}
      <div style={css.footer}>
        <span style={{color:RISK[riskLevel].color,fontWeight:700}}>{RISK[riskLevel].label} RISK</span>
        <span>·</span>
        <span>{isSim?"🧪 SIMULATION — NO REAL MONEY":appMode==="paper"?"📄 PAPER TRADING":"⚡ LIVE TRADING"}</span>
        <span>·</span>
        <span>Size {(RISK[riskLevel].pct*100).toFixed(1)}% · Stop {(RISK[riskLevel].stop*100).toFixed(1)}% · Target {(RISK[riskLevel].target*100).toFixed(1)}%</span>
        {isSim && <><span>·</span><span style={{color:"#3b82f6"}}>Sim P&L: <span style={{color:simPnl>=0?"#10b981":"#ef4444"}}>{simPnl>=0?"+":""}${simPnl.toFixed(2)}</span></span></>}
      </div>
    </div>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const css = {
  root: { display:"flex", flexDirection:"column", height:"100vh", background:"#0b1120", color:"#cbd5e1",
    fontFamily:"'JetBrains Mono','Courier New',monospace", overflow:"hidden" },
  topbar: { display:"flex", alignItems:"center", gap:20, padding:"10px 20px",
    background:"#0d1526", borderBottom:"1px solid #1e293b", flexShrink:0 },
  brand: { display:"flex", alignItems:"center", gap:10, marginRight:8 },
  brandIcon: { fontSize:24, color:"#3b82f6", lineHeight:1 },
  brandName: { fontSize:15, fontWeight:700, letterSpacing:"0.18em", color:"#f1f5f9", fontFamily:"'Inter',sans-serif" },
  brandSub: { fontSize:8, color:"#1e3a5f", letterSpacing:"0.3em" },
  modeGroup: { display:"flex", gap:4 },
  modeBtn: { background:"#1e293b", border:"1px solid #334155", color:"#64748b",
    padding:"5px 14px", fontSize:11, fontFamily:"inherit", fontWeight:700,
    letterSpacing:"0.08em", cursor:"pointer", borderRadius:5 },
  modeBtnActive: { background:"#1e3a5f", color:"#93c5fd", borderColor:"#3b82f6" },
  stats: { display:"flex", gap:24, marginLeft:"auto" },
  stat: { display:"flex", flexDirection:"column", alignItems:"center" },
  statLabel: { fontSize:9, color:"#1e3a5f", letterSpacing:"0.2em", fontWeight:700 },
  statVal: { fontSize:14, fontWeight:700, color:"#e2e8f0", fontFamily:"'Inter',sans-serif" },
  scanStatus: { display:"flex", alignItems:"center", gap:6, fontSize:12 },
  btnPrimary: { background:"#1d4ed8", border:"none", color:"#fff", padding:"7px 18px",
    fontSize:11, fontFamily:"inherit", fontWeight:700, letterSpacing:"0.1em",
    cursor:"pointer", borderRadius:6 },
  btnDanger: { background:"#7f1d1d", border:"none", color:"#fca5a5", padding:"7px 18px",
    fontSize:11, fontFamily:"inherit", fontWeight:700, letterSpacing:"0.1em",
    cursor:"pointer", borderRadius:6 },
  configBar: { display:"flex", alignItems:"flex-end", gap:16, padding:"10px 20px",
    background:"#0d1526", borderBottom:"1px solid #1e293b", flexShrink:0, flexWrap:"wrap" },
  cfgGroup: { display:"flex", flexDirection:"column", gap:4 },
  cfgLabel: { fontSize:9, color:"#1e3a5f", letterSpacing:"0.2em", fontWeight:700 },
  cfgInput: { background:"#0b1120", border:"1px solid #1e293b", borderRadius:5,
    color:"#cbd5e1", padding:"6px 10px", fontSize:12, fontFamily:"inherit" },
  divider: { width:1, background:"#1e293b", alignSelf:"stretch", margin:"0 4px" },
  smBtn: { background:"#0b1120", border:"1px solid #1e293b", borderRadius:4,
    color:"#475569", padding:"5px 10px", fontSize:10, fontFamily:"inherit",
    fontWeight:700, letterSpacing:"0.1em", cursor:"pointer" },
  toggle: { cursor:"pointer", display:"flex", alignItems:"center" },
  toggleTrack: { width:36, height:20, borderRadius:10, transition:"background 0.2s", position:"relative" },
  toggleThumb: { position:"absolute", top:2, width:16, height:16, borderRadius:8, background:"#fff", transition:"transform 0.2s" },
  body: { display:"flex", flex:1, minHeight:0 },
  leftPanel: { flex:1, display:"flex", flexDirection:"column", borderRight:"1px solid #1e293b", minWidth:0 },
  panelHead: { display:"flex", justifyContent:"space-between", alignItems:"center",
    padding:"8px 16px", background:"#0d1526", borderBottom:"1px solid #1e293b", flexShrink:0 },
  panelTitle: { fontSize:10, letterSpacing:"0.2em", color:"#1e3a5f", fontWeight:700 },
  tableHead: { display:"flex", gap:8, padding:"6px 16px", background:"#0d1526",
    borderBottom:"1px solid #1e293b", fontSize:9, color:"#1e3a5f", letterSpacing:"0.15em",
    fontWeight:700, flexShrink:0 },
  tableBody: { flex:1, overflowY:"auto" },
  tableRow: { display:"flex", alignItems:"center", gap:8, padding:"9px 16px",
    borderBottom:"1px solid #0f172a", transition:"background 0.1s" },
  rightPanel: { width:320, display:"flex", flexDirection:"column", flexShrink:0 },
  tabs: { display:"flex", borderBottom:"1px solid #1e293b", flexShrink:0 },
  tab: { flex:1, padding:"9px 0", background:"transparent", border:"none",
    color:"#374151", fontSize:10, fontFamily:"inherit", fontWeight:700,
    letterSpacing:"0.12em", cursor:"pointer", borderBottom:"2px solid transparent" },
  tabActive: { color:"#60a5fa", borderBottom:"2px solid #3b82f6" },
  tabContent: { flex:1, overflowY:"auto", display:"flex", flexDirection:"column", gap:0 },
  posCard: { padding:"12px 14px", borderBottom:"1px solid #0f172a" },
  stratCard: { padding:"12px 14px", borderBottom:"1px solid #0f172a", margin:"0" },
  clearBtn: { background:"transparent", border:"1px solid #1e293b", color:"#374151",
    padding:"3px 10px", fontSize:9, fontFamily:"inherit", cursor:"pointer", borderRadius:3, letterSpacing:"0.1em" },
  emptyState: { padding:30, textAlign:"center", color:"#1e3a5f", fontSize:12, letterSpacing:"0.08em" },
  footer: { display:"flex", gap:10, alignItems:"center", padding:"6px 20px",
    background:"#0d1526", borderTop:"1px solid #1e293b", fontSize:11, color:"#334155", flexShrink:0 },
};
