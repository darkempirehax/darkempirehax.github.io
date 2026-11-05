// App del club: fixture, resultados, plantel, estadísticas y grabaciones.
// Datos en Firebase (Firestore). Lectura libre; escritura solo capitanes.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, deleteDoc, onSnapshot, runTransaction, Bytes } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { renderCalendario, webhookValido, avisosDelDia } from "./scripts/calendario-render.js?v=20261105";
import { analyzeReplay, matchNick } from "./analizador.js?v=20261105";

"use strict";
const COLORS = ["#3a6fd8","#5aa9f0","#22b8cf","#1f9a8a","#2fbf71","#5f7f2e","#a3c94a","#e8c23a","#c48a12","#d0712b","#d4513f","#b3263e","#e04f86","#c2508f","#7b5cd6","#a77ef0","#8d6e63","#9ea7b3","#f1f0ec"];
const POS = {ARQ:"Arquero",DEF:"Defensor",MED:"Medio",DEL:"Delantero"};
const TABS = [["partidos","Partidos"],["calendario","Calendario"],["estadisticas","Estadísticas"],["plantel","Plantel"],["ligas","Ligas"]];
const TZ = "America/Argentina/Buenos_Aires";
const todayStr = () => new Intl.DateTimeFormat("en-CA",{timeZone:TZ}).format(new Date());
const CAL_SLOTS = 5;
const MAX_REC = 900 * 1024;
const EMPTY = () => ({club:{name:"Dark Empire"}, groups:[], leagues:[], players:[], matches:[]});

const app = document.getElementById("app");
const modalHost = document.createElement("div"); document.body.appendChild(modalHost);

let S = null;               // estado del club (null = cargando)
let loadError = null;
let canWrite = false, user = null, busy = false;
const disc = {hook:"", msgId:"", last:"", loaded:false, gh:"", chan:"", emojis:"✅ 🟡 ❌", daySent:""};
const ui = {tab:"partidos", league:"all", sort:"g", open:null, cal: todayStr().slice(0,7)};
ui.leagues = []; ui.groups = []; ui.statMode = "liga"; ui.fOpen = false;   // filtros: vacío = todas
try{ const sv = JSON.parse(localStorage.getItem("hx_ui") || "null"); if(sv){ ui.leagues = Array.isArray(sv.leagues) ? sv.leagues : []; ui.groups = Array.isArray(sv.groups) ? sv.groups : []; ui.statMode = sv.statMode==="grupo" ? "grupo" : "liga"; ui.sort = sv.sort || "g"; } }catch(e){}
function saveUi(){ try{ localStorage.setItem("hx_ui", JSON.stringify({leagues:ui.leagues, groups:ui.groups, statMode:ui.statMode, sort:ui.sort})); }catch(e){} }
function fromHash(){ const h = location.hash.slice(1); if(TABS.some(t => t[0]===h)) ui.tab = h; }
fromHash();

/* ---------- conexión ---------- */
const cfg = (window.CLUB_CONFIG || {}).firebase || {};
let db = null, auth = null, mainRef = null;
if(!cfg.apiKey || !cfg.projectId){
  loadError = "config";
} else {
  const fb = initializeApp(cfg);
  db = getFirestore(fb); auth = getAuth(fb);
  mainRef = doc(db, "club", "datos");
  onSnapshot(mainRef, snap => {
    S = normalize(snap.exists() ? snap.data() : EMPTY());
    loadError = null; document.title = S.club.name; render();
  }, err => { console.error(err); loadError = "read"; render(); });
  onAuthStateChanged(auth, async u => {
    user = u; canWrite = false;
    if(u && u.email){
      try{ const c = await getDoc(doc(db, "capitanes", u.email.toLowerCase())); canWrite = c.exists(); }catch(e){ canWrite = false; }
      if(!canWrite){ toast("Esta cuenta de Google no está habilitada como capitán."); signOut(auth); }
    }
    render();
    if(canWrite) loadDiscord();
  });
}
function normalize(d){ d = d || {}; return {club: d.club || {name:"Dark Empire"}, groups: d.groups || [], leagues: d.leagues || [], players: d.players || [], matches: d.matches || []}; }

async function login(){
  try{ await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch(e){
    const c = e && e.code || "";
    if(c.includes("popup-closed") || c.includes("cancelled")) return;
    if(c.includes("unauthorized-domain")) toast("Falta agregar este dominio en Firebase → Authentication → Configuración → Dominios autorizados.");
    else if(c.includes("popup-blocked")) toast("El navegador bloqueó la ventana de Google. Permití ventanas emergentes para esta página.");
    else toast("No se pudo iniciar sesión. Probá de nuevo.");
  }
}

/* ---------- utilidades ---------- */
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function uid(){ return Math.random().toString(36).slice(2,9) + Date.now().toString(36).slice(-3); }
const L = id => S.leagues.find(l => l.id===id);
const P = id => S.players.find(p => p.id===id);
const posList = p => (Array.isArray(p.pos) ? p.pos : (p.pos ? [p.pos] : [])).filter(k => POS[k]);
const pname = id => { const p=P(id); return p ? p.name : "(jugador borrado)"; };
function fmtDate(d){ if(!d) return "Sin fecha"; const x=new Date(d+"T12:00:00"); if(isNaN(x)) return d;
  return x.toLocaleDateString("es-AR",{weekday:"short",day:"2-digit",month:"2-digit"}).replace(",",""); }
function kb(n){ return n>=1024*1024 ? (n/1024/1024).toFixed(1)+" MB" : Math.round(n/1024)+" KB"; }
function res(m){ if(m.status!=="jugado") return null; if(m.df) return "DF"; const a=+m.gf||0, b=+m.gc||0; return a>b?"G":a<b?"P":"E"; }
// Filtros: se ignoran las ligas/modalidades elegidas que ya no existen.
const selLeagues = () => ui.leagues.filter(id => L(id));
const selGroups = () => ui.groups.filter(id => S.groups.some(g => g.id===id));
const inLeague = m => { const sl = selLeagues(); return !sl.length || sl.includes(m.league); };
const inStats = m => { if(ui.statMode==="grupo"){ const sg = selGroups(); if(!sg.length) return true; const l = L(m.league); return !!l && sg.includes(l.group); } return inLeague(m); };
const G = id => S.groups.find(g => g.id===id);
function record(list){ const r={pj:0,g:0,e:0,p:0,df:0,gf:0,gc:0};
  list.forEach(m => { const x=res(m); if(!x) return; if(x==="DF"){ r.df++; return; } r.pj++; r[x==="G"?"g":x==="E"?"e":"p"]++; r.gf+=+m.gf||0; r.gc+=+m.gc||0; }); return r; }
const key = m => (m.date||"9999-99-99")+" "+(m.time||"99:99");
const upcoming = list => list.filter(m => m.status!=="jugado").sort((a,b) => key(a)<key(b)?-1:1);
const played = list => list.filter(m => m.status==="jugado").sort((a,b) => key(a)<key(b)?1:-1);
function stats(list){
  const t={}; S.players.forEach(p => { t[p.id]={id:p.id,pj:0,pg:0,g:0,a:0,mvp:0,ps:0,pa:0,pm:0}; });
  list.forEach(m => { if(m.status!=="jugado" || m.df) return;
    (m.lineup||[]).forEach(r => { const s=t[r.p]; if(!s) return; s.pj++; if(res(m)==="G") s.pg++; s.g+=+r.g||0; s.a+=+r.a||0; if(+r.pa){ s.ps+=+r.ps||0; s.pa+=+r.pa; s.pm++; } });
    if(m.mvp && t[m.mvp]) t[m.mvp].mvp++; });
  return t;
}
function safeUrl(u){ try{ const x=new URL(String(u||"").trim()); return (x.protocol==="https:"||x.protocol==="http:") ? x.href : ""; }catch(e){ return ""; } }
function tablaBtn(l){ const u=safeUrl(l && l.link); return u ? '<a class="btn ghost small" href="'+esc(u)+'" target="_blank" rel="noopener">Ver tabla ↗</a>' : ''; }
function lgBadge(id){ const l=L(id); return l ? '<span class="dot" style="--lg:'+esc(l.color)+'"></span>'+esc(l.name) : "Sin liga"; }

/* ---------- vistas ---------- */
function render(){
  if(loadError || !S){ app.innerHTML = stateView(); return; }
  const all = S.matches, r = record(all), nx = upcoming(all)[0];
  let h = '<header class="pitch gut"><div class="inner">'
    + '<img class="crest" src="escudo.png" alt="Escudo de '+esc(S.club.name)+'" width="281" height="416">'
    + '<div class="head"><h1 class="club">'+esc(S.club.name)+'</h1></div>'
    + '<div class="meta">'
    + '<div class="record num">'+rec(r.pj,"PJ")+rec(r.g,"Ganados")+rec(r.e,"Empates")+rec(r.p,"Perdidos")+'</div>'
    + (nx ? '<div class="next">Próximo: <b>vs '+esc(nx.rival)+'</b> · '+(L(nx.league)?esc(L(nx.league).name):"")+' · '+esc(fmtDate(nx.date))+(nx.time?" "+esc(nx.time):"")+'</div>' : '')
    + (canWrite ? '<span class="role">Modo capitán</span>' : '')
    + '</div></div></header>';
  h += '<nav class="tabs gut" aria-label="Secciones"><div class="inner">'+TABS.map(t =>
      '<a href="#'+t[0]+'"'+(ui.tab===t[0]?' aria-current="page"':'')+'>'+t[1]+'</a>').join("")+'</div></nav>';
  h += '<main class="gut"><div class="inner">'+({partidos:vMatches,calendario:vCalendar,estadisticas:vStats,plantel:vPlayers,ligas:vLeagues}[ui.tab])()+'</div></main>';
  h += '<footer class="gut"><div class="inner foot-row"><span>'+(canWrite ? 'Lo que guardás se ve al instante para todos.' : 'Los capitanes actualizan esta página.')+'</span>'
    + (canWrite ? '<button class="linkbtn" data-act="logout">Salir del modo capitán</button>' : '<button class="linkbtn" data-act="login">¿Sos capitán? Entrar</button>')
    + '</div></footer>';
  app.innerHTML = h;
}
function stateView(){
  let body;
  if(loadError==="config") body = '<h2>Falta configurar Firebase</h2><p>Completá el archivo <code>config.js</code> con los datos de tu proyecto (paso 2 de la guía) y volvé a subirlo.</p>';
  else if(loadError==="read") body = '<h2>No se pudieron cargar los datos</h2><p>Revisá que las reglas de Firestore estén publicadas (paso 4 de la guía) y recargá la página.</p>';
  else body = '<h2>Cargando…</h2><p class="hint">Trayendo el fixture y las estadísticas.</p>';
  return '<main class="gut" style="padding-block:40px"><div class="inner"><div class="state">'+body+'</div></div></main>';
}
const rec = (v,l,c) => '<div class="rec'+(c?' '+c:'')+'"><b>'+esc(v)+'</b><span>'+l+'</span></div>';
function leagueChips(stats){
  if(!S.leagues.length) return "";
  const mode = stats ? ui.statMode : "liga", sl = selLeagues(), sg = selGroups();
  const sel = mode==="grupo" ? sg : sl;
  const summary = mode==="grupo"
    ? (sg.length ? 'Modalidad: '+sg.map(id => esc(G(id).name)).join(", ") : (stats ? 'Todas las modalidades' : ''))
    : (sl.length ? sl.map(id => '<span class="dot" style="--lg:'+esc(L(id).color)+'"></span>'+esc(L(id).name)).join(", ") : 'Todas las ligas');
  let h = '<div class="fwrap"><button class="btn ghost small" data-act="flt-toggle" aria-expanded="'+ui.fOpen+'">Filtrar'+(sel.length ? ' ('+sel.length+')' : '')+' ▾</button>'
    + '<span class="fsum">'+summary+'</span>';
  if(ui.fOpen){
    h += '<div class="fpanel" role="dialog" aria-label="Filtrar">';
    if(stats) h += '<div class="seg small fmode"><label><input type="radio" name="flt-mode" value="grupo"'+(mode==="grupo"?' checked':'')+'>Por modalidad</label><label><input type="radio" name="flt-mode" value="liga"'+(mode==="liga"?' checked':'')+'>Por liga</label></div>';
    if(mode==="grupo"){
      h += S.groups.length ? '<div class="flist">'+S.groups.map(g => { const n = S.leagues.filter(l => l.group===g.id).length;
          return '<label class="fopt"><input type="checkbox" class="flt-g" value="'+esc(g.id)+'"'+(sg.includes(g.id)?' checked':'')+'> '+esc(g.name)+' <span class="hint">'+n+' liga'+(n===1?'':'s')+'</span></label>'; }).join("")+'</div>'
        : '<div class="hint">Todavía no hay modalidades. '+(canWrite ? 'Creálas en <a href="#ligas">Ligas</a>.' : 'Las crean los capitanes en Ligas.')+'</div>';
    } else {
      h += '<div class="flist">'+S.leagues.map(l => '<label class="fopt"><input type="checkbox" class="flt-l" value="'+esc(l.id)+'"'+(sl.includes(l.id)?' checked':'')+'> <span class="dot" style="--lg:'+esc(l.color)+'"></span>'+esc(l.name)+'</label>').join("")+'</div>';
    }
    h += '<div class="acts"><button class="btn ghost small" data-act="flt-clear">Ver todas</button><button class="btn small" data-act="flt-toggle">Listo</button></div></div>';
  }
  return h + '</div>';
}
function startGuide(){
  return '<div class="empty"><b>Todavía no hay nada cargado.</b>'+(canWrite ?
    '<ol><li>En <a href="#ligas">Ligas</a>, creá las ligas que juegan.</li><li>En <a href="#plantel">Plantel</a>, agregá a los jugadores.</li><li>Acá en Partidos, cargá el fixture y después los resultados.</li></ol>'
    : '<br>Cuando los capitanes carguen el fixture, lo vas a ver acá.')+'</div>';
}
function vMatches(){
  const list = S.matches.filter(inLeague), up = upcoming(list), pl = played(list);
  let h = '<div class="bar">'+leagueChips()+(canWrite ? '<div class="acts">'+(todayMatches().length ? '<button class="btn ghost" data-act="day-notice">Avisar partidos de hoy</button>' : '')+'<button class="btn" data-act="m-new"'+(S.leagues.length?'':' disabled title="Primero creá una liga"')+'>+ Partido</button></div>' : '')+'</div>';
  if(selLeagues().length===1 && tablaBtn(L(selLeagues()[0]))) h += '<div class="acts">'+tablaBtn(L(selLeagues()[0]))+'</div>';
  if(!S.matches.length) return h + startGuide();
  h += '<section class="sec"><h2>Próximos <small>'+up.length+'</small></h2>'+(up.length ? '<div class="list">'+up.map(matchRow).join("")+'</div>' : '<div class="empty">No hay partidos pendientes'+(selLeagues().length?" con este filtro":"")+'.</div>')+'</section>';
  h += '<section class="sec"><h2>Resultados <small>'+pl.length+'</small></h2>'+(pl.length ? '<div class="list">'+pl.map(matchRow).join("")+'</div>' : '<div class="empty">Todavía no hay resultados cargados.</div>')+'</section>';
  return h;
}
function matchRow(m){
  const r = res(m), open = ui.open===m.id, clickable = canWrite || r || m.rec || m.notes;
  let h = '<article class="match"><button class="mrow" data-act="m-open" data-id="'+esc(m.id)+'" aria-expanded="'+open+'"'+(clickable?'':' disabled')+'>'
    + '<div class="mdate"><b>'+esc(fmtDate(m.date))+'</b><span>'+esc(m.time||"Sin hora")+'</span></div>'
    + '<div style="min-width:0"><div class="mmeta">'+lgBadge(m.league)+(m.round?' · '+esc(m.round):'')+(m.rec?' <span class="rectag" title="Tiene grabación">REC</span>':'')+'</div><div class="mrival">vs '+esc(m.rival)+'</div></div>'
    + '<div class="mscorers">'+scorersText(m)+(res(m) && res(m)!=="DF" && m.mvp ? '<div class="mvpline"><span class="mvptag">Figura</span> '+esc(pname(m.mvp))+'</div>' : '')+'</div>'
    + scoreBadge(m)
    + '</button>';
  if(open) h += '<div class="mdetail">'+matchInfo(m)+'</div>';
  return h + '</article>';
}
function scorersText(m){ const r=res(m); if(!r || r==="DF") return "";
  return (m.lineup||[]).filter(x => +x.g>0).sort((p,q) => q.g-p.g || pname(p.p).localeCompare(pname(q.p))).map(x => esc(pname(x.p))+' x'+(+x.g)).join(", "); }
function scoreBadge(m){ const r=res(m);
  return r==="DF" ? '<div class="score DF" aria-label="Ganado por DF, 3 a 0" title="El rival no se presentó (3–0)">DF</div>'
    : r ? '<div class="score num '+r+'" aria-label="Resultado '+(+m.gf)+' a '+(+m.gc)+'">'+(+m.gf)+'–'+(+m.gc)+'</div>' : '<span class="pend">Pendiente</span>'; }
function matchInfo(m){
  const r = res(m); let h = '';
    if(r==="DF"){ h += '<div>Ganado 3–0 por DF: el rival no se presentó.</div>'+(m.notes?'<div>'+esc(m.notes)+'</div>':''); }
    else if(r){
      const list = f => (m.lineup||[]).filter(x => +x[f]>0).sort((a,b) => b[f]-a[f]).map(x => esc(pname(x.p))+(x[f]>1?" ×"+x[f]:"")).join(", ");
      const pj = (m.lineup||[]).map(x => esc(pname(x.p))).join(", ");
      h += '<dl><dt>Goles</dt><dd>'+(list("g")||"—")+'</dd><dt>Asistencias</dt><dd>'+(list("a")||"—")+'</dd><dt>Figura</dt><dd>'+(m.mvp?esc(pname(m.mvp)):"—")+'</dd><dt>Jugaron</dt><dd>'+(pj||"—")+'</dd>'+(m.notes?'<dt>Notas</dt><dd>'+esc(m.notes)+'</dd>':'')+'</dl>';
    } else if(m.notes){ h += '<div>'+esc(m.notes)+'</div>'; }
    if(m.rec) h += '<div class="recbox"><button class="btn small" data-act="rec-dl" data-id="'+esc(m.id)+'">Descargar grabación ('+kb(m.rec.size||0)+')</button><span class="hint">Para verla, abrila en <a href="https://www.haxball.com/replay" target="_blank" rel="noopener">haxball.com/replay</a>.</span></div>';
    if(canWrite) h += '<div class="acts"><button class="btn small ghost" data-act="m-edit" data-id="'+esc(m.id)+'">'+(r?'Editar resultado':'Cargar resultado / editar')+'</button>'+(r && r!=="DF" && m.rec ? '<button class="btn small ghost" data-act="m-report" data-id="'+esc(m.id)+'">Informe</button>' : '')+'</div>';
  if(!h) h = '<div class="hint">'+(r ? 'Sin detalles cargados.' : 'Partido programado.')+'</div>';
  return h;
}
/* ---------- Informe del partido (texto para Discord) ---------- */
const fmtMS = t => { t = Math.max(0, Math.round(t||0)); return Math.floor(t/60)+":"+String(t%60).padStart(2,"0"); };
const dmd = x => String(x||"").trim().replace(/[\\*_`~|]/g, "\\$&");   // escapar formato de Discord en los nicks
function reportData(games){
  const inc = games.map(g => g.ticks >= 3600 || g.goals.length > 0); if(!inc.some(Boolean)) games.forEach((g,i) => inc[i] = true);
  const pool = S.players.map(p => ({id:p.id, name:p.name, aliases:p.aliases||[]}));
  const teamOf = pl => pl.ticks[1] >= pl.ticks[2] ? 1 : 2;
  const ours = [], sure = [];
  games.forEach((g,i) => { const c = {1:0, 2:0}; Object.values(g.players).forEach(pl => { const r = matchNick(pl.name, pool); if(r) c[teamOf(pl)] += r.kind==="memoria" ? 2 : 1; });
    ours[i] = c[2] > c[1] ? 2 : 1; sure[i] = c[1] !== c[2]; });
  games.forEach((g,i) => { if(sure[i]) return; const j = sure.findIndex(Boolean); if(j<0) return;
    const set = new Set(Object.values(games[j].players).filter(pl => teamOf(pl)===ours[j]).map(pl => pl.name)), c = {1:0, 2:0};
    Object.values(g.players).forEach(pl => { if(set.has(pl.name)) c[teamOf(pl)]++; }); if(c[1]!==c[2]) ours[i] = c[2] > c[1] ? 2 : 1; });
  const side = (who) => {   // who: "us" | "them"
    const colorAt = i => who==="us" ? ours[i] : 3 - ours[i];
    const o = {starters: [], players: {}, goals: {}, assists: {}, og: {}, own: 0, gk: {}, gf: 0, firstConceded: null, total: 0};
    let offset = 0, startersSet = false;
    games.forEach((g,i) => { if(!inc[i]) return; const c = colorAt(i);
      if(!startersSet && g.starters){ o.starters = g.starters[c].slice(); startersSet = true; }
      Object.values(g.players).forEach(pl => { if(teamOf(pl)!==c || pl.ticks[c] < 180) return; o.players[pl.name] = (o.players[pl.name]||0) + pl.ticks[c]; });
      Object.entries(g.deep||{}).forEach(([n,d]) => { if(d[c]) o.gk[n] = (o.gk[n]||0) + d[c]; });
      g.goals.forEach(x => {
        if(x.team===c){ o.gf++; if(x.scorer) o.goals[x.scorer.name] = (o.goals[x.scorer.name]||0) + 1; if(!x.scorer && x.own) o.og[x.own.name] = (o.og[x.own.name]||0) + 1; if(x.assist) o.assists[x.assist.name] = (o.assists[x.assist.name]||0) + 1; }
        else if(o.firstConceded==null) o.firstConceded = offset + (x.time||0);
      });
      offset += g.dur || g.ticks/60;
    });
    o.total = offset;
    o.starters = o.starters.filter(n => o.players[n] != null || true);
    o.subs = Object.keys(o.players).filter(n => !o.starters.includes(n)).sort((a,b) => o.players[b]-o.players[a]);
    o.gkAuto = Object.keys(o.gk).sort((a,b) => o.gk[b]-o.gk[a])[0] || o.starters[0] || "";
    o.valla = o.firstConceded==null ? o.total : o.firstConceded;
    return o;
  };
  return {us: side("us"), them: side("them")};
}
function reportText(D, f){
  const E1 = f.ourEmoji ? f.ourEmoji+" " : "", E2 = f.rivEmoji ? f.rivEmoji+" " : "";
  const lineup = (o, gk) => { const st = o.starters.slice(); const i = st.indexOf(gk); if(i>0){ st.splice(i,1); st.unshift(gk); } return st.map(dmd).join(" - "); };
  const cnt = obj => Object.entries(obj).sort((a,b) => b[1]-a[1]).map(([n,k]) => dmd(n)+" x"+k).join(" ") || "❌";
  const block = (o, E, gk) => [
    "**⚽ `GOLES` "+E+":** "+([Object.entries(o.goals).sort((a,b) => b[1]-a[1]).map(([n,k]) => dmd(n)+" x"+k).join(" "), Object.entries(o.og).map(([n,k]) => dmd(n)+" OG"+(k>1?" x"+k:"")).join(" ")].filter(Boolean).join(" ") || "❌"),
    "**🎩 `ASISTENCIAS` "+E+":** "+cnt(o.assists),
    "🥅 **`VALLAS` "+E+":** "+(gk ? dmd(gk)+" " : "")+fmtMS(o.valla)];
  const who = n => D.us.players[n]!=null || D.us.starters.includes(n) ? f.ourEmoji : f.rivEmoji;
  const L = [];
  L.push("-#  "+(f.compEmoji ? f.compEmoji+":" : "")+"__"+(f.round ? f.round+"  - " : "")+f.title+"__");
  L.push("# ** "+E1+" `"+f.ourName+" "+D.us.gf+" - "+D.them.gf+" "+f.rivName+"` "+(f.rivEmoji||"")+" **");
  L.push("-# **`FORMACIONES`**");
  L.push(E1+"*"+lineup(D.us, f.gkUs)+"*"); L.push("-# cambios: "+(D.us.subs.map(dmd).join(" - ") || "❌"));
  L.push(E2+"*"+lineup(D.them, f.gkThem)+"*"); L.push("-# cambios: "+(D.them.subs.map(dmd).join(" - ") || "❌"));
  L.push("");
  L.push(...block(D.us, (f.ourEmoji||"").trim(), f.gkUs)); L.push("");
  L.push(...block(D.them, (f.rivEmoji||"").trim(), f.gkThem)); L.push("");
  L.push("🏅 **`FIGURA:`** "+(f.figura ? dmd(f.figura)+" "+(who(f.figura)||"") : "❌"));
  L.push("👏 **`DESTACADOS:`** "+(f.dest.length ? f.dest.map(n => dmd(n)+" "+(who(n)||"")).join(" - ") : "❌"));
  L.push("");
  L.push("⚠️ **`INCIDENTE:`** *"+(f.incidente || "Ninguna")+"*");
  L.push("");
  L.push("**📹 `VIDEO:`** "+(f.video||""));
  return L.join("\n").replace(/[ ]+\n/g, "\n");
}
async function reportModal(m){
  if(!m.rec){ toast("Este partido no tiene grabación guardada."); return; }
  openModal('<div class="pview"><h2>Informe · vs '+esc(m.rival)+'</h2><div id="repbody"><div class="anbox"><b>Analizando la grabación…</b> <span id="repprog">0%</span></div></div></div>');
  let D;
  try{
    const snap = await getDoc(doc(db,"grabaciones",m.rec.id)); if(!snap.exists()) throw new Error("No se encontró la grabación guardada.");
    const games = await analyzeReplay(snap.data().data.toUint8Array(), {onProgress: p => { const e = document.getElementById("repprog"); if(e) e.textContent = Math.round(p*100)+"%"; }});
    if(!games.length) throw new Error("No encontré ningún partido jugado en esa grabación.");
    D = reportData(games);
  }catch(err){ console.error(err); const b = document.getElementById("repbody"); if(b) b.innerHTML = '<div class="hint warn">'+esc(err.message||"No se pudo analizar la grabación.")+'</div><div class="mfoot"><button type="button" class="btn" data-act="close">Cerrar</button></div>'; return; }
  const body = document.getElementById("repbody"); if(!body) return;
  const l = L(m.league) || {}, rp = m.report || {};
  const allNicks = [...new Set([...D.us.starters, ...Object.keys(D.us.players), ...D.them.starters, ...Object.keys(D.them.players)])];
  let figDefault = rp.figura || "";
  if(!figDefault && m.mvp){ const p = P(m.mvp); if(p) figDefault = [...D.us.starters, ...Object.keys(D.us.players)].find(n => { const r = matchNick(n, [{id:p.id, name:p.name, aliases:p.aliases||[]}]); return r && r.score >= 0.84; }) || ""; }
  const f = {compEmoji: l.repEmoji||"", title: l.repTitle||l.name||"", round: m.round||"", ourName: l.repTeam||"Dark Empire", ourEmoji: l.repTeamEmoji||"",
    rivName: m.rival||"", rivEmoji: m.rivalEmoji||"", gkUs: rp.gkUs||D.us.gkAuto, gkThem: rp.gkThem||D.them.gkAuto, figura: figDefault,
    dest: (rp.dest||[]).filter(n => allNicks.includes(n)), incidente: rp.incidente||"Ninguna", video: rp.video||""};
  const nickOpts = (list, sel, none) => (none ? '<option value="">'+none+'</option>' : '')+list.map(n => '<option'+(n===sel?' selected':'')+'>'+esc(n)+'</option>').join("");
  const usList = [...new Set([...D.us.starters, ...Object.keys(D.us.players)])], themList = [...new Set([...D.them.starters, ...Object.keys(D.them.players)])];
  body.innerHTML = '<div class="fields">'
    + '<label class="f">Emoji de la competición<input type="text" autocomplete="off" id="r-ce" value="'+esc(f.compEmoji)+'" placeholder="<:ChampionsLeague:…>"></label>'
    + '<label class="f">Competición<input type="text" autocomplete="off" id="r-ti" value="'+esc(f.title)+'" placeholder="Nations League | 1ra Edición x7"></label>'
    + '<label class="f">Fase / ronda<input type="text" autocomplete="off" id="r-ro" value="'+esc(f.round)+'" placeholder="Semifinal"></label>'
    + '<label class="f">Nuestro nombre en esta liga<input type="text" autocomplete="off" id="r-on" value="'+esc(f.ourName)+'"></label>'
    + '<label class="f">Nuestro emoji<input type="text" autocomplete="off" id="r-oe" value="'+esc(f.ourEmoji)+'" placeholder="<:juventus:…>"></label>'
    + '<label class="f">Rival<input type="text" autocomplete="off" id="r-rn" value="'+esc(f.rivName)+'"></label>'
    + '<label class="f">Emoji del rival<input type="text" autocomplete="off" id="r-re" value="'+esc(f.rivEmoji)+'" placeholder="<:Atleticomadrid:…>"></label>'
    + '<label class="f">Nuestro arquero<select id="r-gu">'+nickOpts(usList, f.gkUs)+'</select></label>'
    + '<label class="f">Arquero rival<select id="r-gt">'+nickOpts(themList, f.gkThem)+'</select></label>'
    + '<label class="f">Figura<select id="r-fi">'+nickOpts(allNicks, f.figura, "—")+'</select></label>'
    + '<label class="f">Incidente<input type="text" autocomplete="off" id="r-in" value="'+esc(f.incidente)+'"></label>'
    + '<label class="f">Video<input type="text" autocomplete="off" id="r-vi" value="'+esc(f.video)+'" placeholder="Link del video"></label></div>'
    + '<div class="filein"><span>Destacados</span><div class="chips poschk">'+allNicks.map((n,i) => '<label class="chip"><input type="checkbox" class="r-de" value="'+esc(n)+'"'+(f.dest.includes(n)?' checked':'')+'>'+esc(n)+'</label>').join("")+'</div></div>'
    + '<div class="hint">Los emojis del servidor se pegan como &lt;:nombre:id&gt;: en Discord escribí \\:nombre: y copiá lo que aparece. Las vallas son el tiempo que pasó hasta el primer gol recibido.</div>'
    + '<textarea id="r-out" class="dcpre" readonly rows="14"></textarea>'
    + '<div class="mfoot"><button type="button" class="btn ghost" id="r-save" style="margin-right:auto">Guardar datos</button><button type="button" class="btn ghost" data-act="close">Cerrar</button><button type="button" class="btn" id="r-copy">Copiar texto</button></div>';
  const $ = id => document.getElementById(id);
  const read = () => { f.compEmoji=$("r-ce").value.trim(); f.title=$("r-ti").value.trim(); f.round=$("r-ro").value.trim(); f.ourName=$("r-on").value.trim(); f.ourEmoji=$("r-oe").value.trim();
    f.rivName=$("r-rn").value.trim(); f.rivEmoji=$("r-re").value.trim(); f.gkUs=$("r-gu").value; f.gkThem=$("r-gt").value; f.figura=$("r-fi").value;
    f.incidente=$("r-in").value.trim(); f.video=$("r-vi").value.trim(); f.dest=[...body.querySelectorAll(".r-de:checked")].map(x => x.value); };
  const upd = () => { read(); $("r-out").value = reportText(D, f); };
  body.addEventListener("input", upd); body.addEventListener("change", upd); upd();
  // Guarda lo que se completó (liga y partido) sin cerrar la ventana: así la próxima vez ya aparece.
  async function saveRep(loud){ read();
    try{ await runTransaction(db, async tx => { const snap = await tx.get(mainRef); const n = JSON.parse(JSON.stringify(normalize(snap.exists() ? snap.data() : EMPTY())));
        const lg = n.leagues.find(x => x.id===m.league); if(lg){ lg.repEmoji=f.compEmoji; lg.repTitle=f.title; lg.repTeam=f.ourName; lg.repTeamEmoji=f.ourEmoji; }
        const mm = n.matches.find(x => x.id===m.id); if(mm){ mm.round=f.round; mm.rivalEmoji=f.rivEmoji; mm.report={gkUs:f.gkUs, gkThem:f.gkThem, figura:f.figura, dest:f.dest, incidente:f.incidente, video:f.video}; }
        tx.set(mainRef, JSON.parse(JSON.stringify(n))); });
      if(loud) toast("Datos del informe guardados"); scheduleDiscord();
    }catch(err){ console.error(err); if(loud) toast(errMsg(err, "No se pudo guardar.")); }
  }
  $("r-copy").addEventListener("click", () => { const t = $("r-out").value; saveRep(false);
    const fallback = () => { $("r-out").select(); toast("Seleccioné el texto: copialo con Ctrl+C"); };
    try{ navigator.clipboard.writeText(t).then(() => toast("Informe copiado: pegalo en Discord"), fallback); }catch(e){ fallback(); } });
  $("r-save").addEventListener("click", () => saveRep(true));
}
function matchModal(m){
  const d = m.date ? new Date(m.date+"T12:00:00").toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long"}) : "Sin fecha";
  openModal('<div class="pview"><div class="mmeta">'+lgBadge(m.league)+(m.round?' · '+esc(m.round):'')+(m.rec?' <span class="rectag">REC</span>':'')+'</div>'
    + '<div class="mhead"><div style="min-width:0"><h2>vs '+esc(m.rival)+'</h2><div class="hint">'+esc(d.charAt(0).toUpperCase()+d.slice(1))+(m.time?' · '+esc(m.time):'')+'</div></div>'+scoreBadge(m)+'</div>'
    + '<div class="mdetail boxed">'+matchInfo(m)+'</div>'
    + '<div class="mfoot"><button type="button" class="btn" data-act="close">Cerrar</button></div></div>');
}
function vCalendar(){
  const [y,mo] = ui.cal.split("-").map(Number);
  const pad = n => String(n).padStart(2,"0");
  const first = new Date(Date.UTC(y,mo-1,1)), days = new Date(Date.UTC(y,mo,0)).getUTCDate();
  const lead = (first.getUTCDay()+6)%7;
  const monthName = first.toLocaleDateString("es-AR",{month:"long",year:"numeric",timeZone:"UTC"});
  const byDay = {};
  S.matches.filter(inLeague).forEach(m => { if(m.date && m.date.slice(0,7)===ui.cal) (byDay[m.date] = byDay[m.date] || []).push(m); });
  Object.values(byDay).forEach(a => a.sort((p,q) => (p.time||"99:99").localeCompare(q.time||"99:99")));
  const t = todayStr(), thisMonth = t.slice(0,7);
  const label = {G:"Ganado",E:"Empate",P:"Perdido",DF:"DF"};
  let h = '<div class="bar">'+leagueChips()+'</div>';
  h += '<div class="calhead"><button class="btn ghost small calnav" data-act="cal" data-id="-1" aria-label="Mes anterior">‹</button>'
    + '<h2 class="calmonth">'+esc(monthName)+'</h2>'
    + '<button class="btn ghost small calnav" data-act="cal" data-id="1" aria-label="Mes siguiente">›</button>'
    + (ui.cal!==thisMonth ? '<button class="btn ghost small" data-act="cal" data-id="0">Hoy</button>' : '')+'</div>';
  h += '<div class="cal">'+["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"].map(w => '<div class="calwd">'+w+'</div>').join("");
  for(let i=0;i<lead;i++) h += '<div class="calday blank" aria-hidden="true"></div>';
  for(let d=1; d<=days; d++){
    const ds = ui.cal+"-"+pad(d), ms = byDay[ds] || [];
    let strips = '';
    for(let s=0; s<CAL_SLOTS; s++){
      const m = ms[s];
      if(!m){ strips += '<span class="strip empty"></span>'; continue; }
      const r = res(m), l = L(m.league), ln = l ? l.name : "Sin liga";
      const desc = (m.time?m.time+' · ':'')+'vs '+m.rival+' · '+ln+' · '+(r==="DF"?"DF (3–0)":r?(+m.gf)+'–'+(+m.gc)+' '+label[r]:"Programado");
      strips += '<button class="strip '+(r||"PEND")+'" style="--lg:'+esc(l?l.color:"#777")+'" data-act="m-view" data-id="'+esc(m.id)+'" title="'+esc(desc)+'" aria-label="'+esc(desc)+'"><span>'+esc(ln)+'</span></button>';
    }
    h += '<div class="calday'+(ds===t?' today':'')+'"><div class="calnum"><span>'+d+'</span>'+(ms.length>CAL_SLOTS?'<em>+'+(ms.length-CAL_SLOTS)+'</em>':'')+'</div><div class="strips">'+strips+'</div></div>';
  }
  const tail = (7 - (lead+days)%7) % 7;
  for(let i=0;i<tail;i++) h += '<div class="calday blank" aria-hidden="true"></div>';
  h += '</div>';
  h += '<div class="legend"><span><i class="strip G"></i>Ganado</span><span><i class="strip E"></i>Empate</span><span><i class="strip P"></i>Perdido</span><span><i class="strip DF"></i>DF</span><span><i class="strip PEND"></i>Programado</span><span class="hint">El borde izquierdo tiene el color de la liga.</span></div>';
  return h;
}
function vStats(){
  const t = stats(S.matches.filter(inStats));
  const rows = S.players.map(p => t[p.id]).filter(s => P(s.id).active!==false || s.pj>0);
  const k = ui.sort, val = (s) => k==="ga" ? s.g+s.a : k==="pp" ? (s.pa ? s.ps/s.pa : -1) : k==="ppm" ? (s.pm ? s.ps/s.pm : -1) : k==="avg" ? (s.pj ? s.g/s.pj : -1) : k==="avga" ? (s.pj ? (s.g+s.a)/s.pj : -1) : s[k];
  rows.sort((a,b) => k==="name" ? P(a.id).name.localeCompare(P(b.id).name)
    : (val(b)-val(a) || (b.g+b.a)-(a.g+a.a) || P(a.id).name.localeCompare(P(b.id).name)));
  let h = '<div class="bar">'+leagueChips(true)+'</div>';
  if(!S.players.length) return h + '<div class="empty">'+(canWrite?'Agregá jugadores en <a href="#plantel">Plantel</a> y cargá resultados para ver las estadísticas.':'Todavía no hay jugadores cargados.')+'</div>';
  function top(f,label){ let best=0; rows.forEach(s => { best=Math.max(best,f(s)); });
    const ties = best ? rows.filter(s => f(s)===best).map(s => P(s.id).name) : [];
    return '<div class="leader"><span>'+label+'</span>'+(best ? '<i class="num">'+best+'</i><b>'+esc(ties.join(", "))+'</b>' : '<b>—</b>')+'</div>'; }
  h += '<div class="leaders">'+top(s=>s.g,"Goleador")+top(s=>s.a,"Asistidor")+top(s=>s.mvp,"Más veces figura")+'</div>';
  const cols=[["name","Jugador"],["pj","PJ"],["pg","PG"],["g","Goles"],["a","Asist."],["ga","G+A"],["mvp","Figura"],["ps","Pases"],["ppm","PxP"],["pp","%P.Acertados"],["avg","Prom. gol"],["avga","Prom. G+A"]];
  h += '<div class="tablewrap"><table><thead><tr>'+cols.map(c => '<th scope="col"><button data-act="sort" data-id="'+c[0]+'" aria-pressed="'+(k===c[0])+'">'+c[1]+(k===c[0]&&c[0]!=="name"?" ▾":"")+'</button></th>').join("")+'</tr></thead><tbody>'
    + rows.map(s => { const p=P(s.id), hl = c => k===c?' class="hl"':'';
      return '<tr'+(p.active===false?' class="off"':'')+'><td><button class="pname" data-act="p-view" data-id="'+esc(p.id)+'">'+esc(p.name)+'</button>'+posList(p).map(k => '<span class="pos">'+esc(k)+'</span>').join("")+'</td><td'+hl("pj")+'>'+s.pj+'</td><td'+hl("pg")+'>'+s.pg+'</td><td'+hl("g")+'>'+s.g+'</td><td'+hl("a")+'>'+s.a+'</td><td'+hl("ga")+'>'+(s.g+s.a)+'</td><td'+hl("mvp")+'>'+s.mvp+'</td><td'+hl("ps")+'>'+(s.pa?s.ps:"—")+'</td><td'+hl("ppm")+'>'+(s.pm?(s.ps/s.pm).toFixed(1):"—")+'</td><td'+hl("pp")+'>'+(s.pa?Math.round(100*s.ps/s.pa)+"%":"—")+'</td><td'+hl("avg")+'>'+(s.pj?(s.g/s.pj).toFixed(2):"—")+'</td><td'+hl("avga")+'>'+(s.pj?((s.g+s.a)/s.pj).toFixed(2):"—")+'</td></tr>'; }).join("")
    + '</tbody></table></div>'
    + '<div class="hint">Pases = pases acertados (el compañero recibió la pelota, pateándola o con el cuerpo). PxP = pases acertados por partido (entre los partidos con pases cargados). %P.Acertados = pases acertados ÷ pases intentados.</div>';
  return h;
}
function vPlayers(){
  const t = stats(S.matches);
  const sorter = (a,b) => a.name.localeCompare(b.name);
  const act = S.players.filter(p => p.active!==false).sort(sorter), off = S.players.filter(p => p.active===false).sort(sorter);
  let h = '<div class="bar"><h2 style="font-size:22px;font-weight:600">Plantel <small class="hint">'+act.length+' jugadores</small></h2>'+(canWrite?'<button class="btn" data-act="p-new">+ Agregar jugadores</button>':'')+'</div>';
  if(!S.players.length) return h + '<div class="empty">'+(canWrite?'Agregá a tus jugadores: podés pegar todos los nicks juntos, uno por línea.':'Todavía no hay jugadores cargados.')+'</div>';
  function card(p){ const s=t[p.id]; const inner = '<h3><span class="shirt num">'+esc(p.num||"·")+'</span>'+esc(p.name)+'</h3>'
      + '<div class="sub">'+esc(posList(p).map(k => POS[k]).join(" · ")||"Sin posición")+(p.active===false?' · De baja':'')+'</div>'
      + '<div class="minis"><span><b>'+s.pj+'</b> PJ</span><span><b>'+s.g+'</b> goles</span><span><b>'+s.a+'</b> asist.</span></div>';
    return '<button class="card" data-act="p-view" data-id="'+esc(p.id)+'">'+inner+'</button>'; }
  h += '<div class="grid">'+act.map(card).join("")+'</div>';
  if(off.length) h += '<section class="sec"><h2>De baja <small>'+off.length+'</small></h2><div class="grid off">'+off.map(card).join("")+'</div></section>';
  return h;
}
function vLeagues(){
  let h = '<div class="bar"><h2 style="font-size:22px;font-weight:600">Ligas</h2>'+(canWrite?'<div class="acts"><button class="btn ghost" data-act="club">Cambiar nombre del club</button><button class="btn" data-act="l-new">+ Liga</button></div>':'')+'</div>';
  if(!S.leagues.length) return h + '<div class="empty">'+(canWrite?'Creá la primera liga para empezar a cargar el fixture.':'Todavía no hay ligas cargadas.')+'</div>' + discordSection();
  h += '<div class="grid">'+S.leagues.map(l => {
    const ms = S.matches.filter(m => m.league===l.id), r = record(ms), pend = ms.filter(m => m.status!=="jugado").length;
    const inner = '<h3><span class="dot" style="--lg:'+esc(l.color)+';width:12px;height:12px"></span>'+esc(l.name)+'</h3>'
      + '<div class="sub">'+(G(l.group)?'<span class="gtag">'+esc(G(l.group).name)+'</span> ':'')+(l.note?esc(l.note)+' · ':'')+pend+' pendiente'+(pend===1?'':'s')+'</div>'
      + '<div class="minis num"><span><b>'+r.pj+'</b> PJ</span><span><b>'+r.g+'-'+r.e+'-'+r.p+'</b> G-E-P</span>'+(r.df?'<span><b>'+r.df+'</b> DF</span>':'')+'</div>';
    const acts = tablaBtn(l) + (canWrite ? '<button class="btn ghost small" data-act="l-edit" data-id="'+esc(l.id)+'">Editar</button>' : '');
    return '<div class="card">'+inner+(acts?'<div class="acts">'+acts+'</div>':'')+'</div>';
  }).join("")+'</div>';
  return h + groupsSection() + discordSection();
}
function groupsSection(){
  if(!canWrite && !S.groups.length) return "";
  return '<section class="sec"><h2>Modalidades <small>para filtrar las estadísticas</small></h2>'
    + '<div class="chips">'+S.groups.map(g => { const n = S.leagues.filter(l => l.group===g.id).length;
        return canWrite ? '<button class="chip" data-act="g-edit" data-id="'+esc(g.id)+'">'+esc(g.name)+' <span class="hint">'+n+'</span></button>' : '<span class="chip">'+esc(g.name)+' <span class="hint">'+n+'</span></span>'; }).join("")
    + (canWrite ? '<button class="chip" data-act="g-new">+ Modalidad</button>' : '')+'</div>'
    + (canWrite ? '<div class="hint">Creá modalidades (por ejemplo x5 y x7) y marcá sus ligas tocando la modalidad. En Estadísticas vas a poder filtrar por modalidad.</div>' : '')+'</section>';
}
function groupForm(g){
  const isNew = !g; g = g || {id:uid(), name:""};
  const used = S.leagues.filter(l => l.group===g.id);
  openModal('<form id="gf"><h2>'+(isNew?'Nueva modalidad':esc(g.name))+'</h2>'
    + '<label class="f">Nombre<input type="text" id="f-gname" required maxlength="30" value="'+esc(g.name)+'" placeholder="Ej: x5, x7, Futsal"></label>'
    + '<div class="filein"><span>Ligas de esta modalidad</span>'+(S.leagues.length ? '<div class="flist">'+S.leagues.map(l => { const other = l.group && l.group!==g.id && G(l.group);
        return '<label class="fopt"><input type="checkbox" class="g-lg" value="'+esc(l.id)+'"'+(l.group===g.id?' checked':'')+'> <span class="dot" style="--lg:'+esc(l.color)+'"></span>'+esc(l.name)+(other ? ' <span class="hint">ahora en '+esc(other.name)+'</span>' : '')+'</label>'; }).join("")+'</div>'
      + '<span class="hint">Marcá las ligas que pertenecen a esta modalidad. Si marcás una que está en otra, se pasa a esta.</span>' : '<span class="hint">Todavía no hay ligas.</span>')+'</div>'
    + foot(isNew ? "" : (used.length ? "Las "+used.length+" ligas de esta modalidad quedan sin modalidad. ¿Borrarla?" : "¿Borrar esta modalidad?"))+'</form>');
  onDelete = () => commit(n => { n.groups = (n.groups||[]).filter(x => x.id!==g.id); n.leagues.forEach(l => { if(l.group===g.id) delete l.group; }); }, "Modalidad borrada");
  document.getElementById("gf").addEventListener("submit", e => { e.preventDefault(); const nm = document.getElementById("f-gname").value.trim(); if(!nm) return;
    const picked = new Set([...document.querySelectorAll("#gf .g-lg:checked")].map(x => x.value));
    commit(n => { n.groups = n.groups || []; const i = n.groups.findIndex(x => x.id===g.id); if(i<0) n.groups.push({id:g.id, name:nm}); else n.groups[i].name = nm;
      n.leagues.forEach(l => { if(picked.has(l.id)) l.group = g.id; else if(l.group===g.id) delete l.group; }); }, isNew ? "Modalidad creada" : "Modalidad actualizada"); });
}

/* ---------- Discord: mensaje del calendario ---------- */
function discordSection(){
  if(!canWrite) return "";
  const ok = !!disc.hook;
  return '<section class="sec"><h2>Discord <small>solo capitanes</small></h2><div class="card">'
    + '<div class="sub">Mensaje "Calendario de partidos oficiales" en tu canal de Discord. Se actualiza solo cada vez que un capitán guarda un cambio.</div>'
    + (!disc.loaded ? '<div class="hint">Cargando configuración…</div>'
      : ok ? '<div class="hint">Webhook configurado · '+(disc.msgId ? 'mensaje publicado' : 'mensaje todavía sin publicar')+(disc.last ? ' · última actualización '+esc(disc.last) : '')+'</div>'
      : '<div class="hint warn">Falta configurar el webhook del canal del calendario.</div>')
    + '<div class="acts"><button class="btn small" data-act="dc-config">'+(ok ? 'Cambiar webhook' : 'Configurar webhook')+'</button>'
    + '<button class="btn ghost small" data-act="dc-preview">Ver mensaje</button>'
    + (ok ? '<button class="btn ghost small" data-act="dc-sync">Actualizar ahora</button>' : '')
    + (ok && disc.msgId ? '<button class="btn ghost small" data-act="dc-new">Publicar de nuevo</button>' : '')
    + '</div></div>'
    + '<div class="card"><div class="sub">Aviso de los partidos del día: un mensaje por partido, etiquetando el rol de la liga y con reacciones. Se manda con el botón <b>Avisar partidos de hoy</b> en Partidos.</div>'
    + (!disc.loaded ? '' : disc.gh && disc.chan ? '<div class="hint">Avisos configurados · canal '+esc(disc.chan)+' · reacciones: '+(esc(disc.emojis)||'ninguna')+'</div>' : '<div class="hint warn">Faltan configurar los avisos del día.</div>')
    + (disc.loaded ? (()=>{ const sin = S.leagues.filter(l => !l.role).length; return sin ? '<div class="hint">'+sin+' liga'+(sin>1?'s':'')+' sin rol de Discord: se van a nombrar sin etiquetar. Cargalo en <b>Editar</b> de cada liga.</div>' : ''; })() : '')
    + '<div class="acts"><button class="btn small" data-act="bot-config">'+(disc.gh ? 'Cambiar configuración' : 'Configurar avisos')+'</button></div></div></section>';
}
/* ---------- Discord: aviso de los partidos del día ----------
   Discord no deja que el navegador use el bot, así que la página le pide a GitHub que corra
   la tarea "Avisos del día en Discord" (.github/workflows/avisos-dia.yml), que manda los mensajes
   con el bot y pone las reacciones. Para pedírselo usa un token de GitHub que solo ven los capitanes. */
const GH_REPO = (() => { const h = location.hostname; return /\.github\.io$/i.test(h) ? h.split(".")[0]+"/"+h.toLowerCase() : ""; })();
function todayMatches(){ return avisosDelDia(S, todayStr()); }
function dayNoticeForm(){
  const ms = todayMatches(), again = disc.daySent===todayStr();
  if(!disc.gh || !disc.chan){ toast("Primero configurá los avisos en Ligas → Discord."); return; }
  openModal('<div class="pview"><h2>Avisar partidos de hoy</h2>'
    + (ms.length ? '<div class="hint">Se van a mandar '+ms.length+' mensaje'+(ms.length>1?'s':'')+' al canal, cada uno con las reacciones '+esc(disc.emojis||"(ninguna)")+':</div><pre class="dcpre">'+esc(ms.map(m => m.preview).join("\n"))+'</pre>'
        + (ms.some(m => !m.roles.length) ? '<div class="hint warn">Alguna liga no tiene rol de Discord: se nombra sin etiquetar.</div>' : '<div class="hint">El @ es la etiqueta del rol de cada liga.</div>')
        + (again ? '<div class="hint warn">Hoy ya se mandó el aviso. Si lo mandás otra vez, van a quedar repetidos.</div>' : '')
      : '<div class="empty">No hay partidos pendientes programados para hoy.</div>')
    + '<div class="hint" id="daystat"></div>'
    + '<div class="mfoot"><button type="button" class="btn ghost" data-act="close">Cancelar</button>'+(ms.length ? '<button type="button" class="btn" id="day-send">'+(again?'Mandar de nuevo':'Mandar')+'</button>' : '')+'</div></div>');
  const btn = document.getElementById("day-send"); if(!btn) return;
  btn.addEventListener("click", async () => {
    if(busy) return; const st = document.getElementById("daystat");
    if(!GH_REPO){ st.textContent = "Esto funciona solo desde la página publicada en GitHub."; st.className = "hint warn"; return; }
    busy = true; btn.disabled = true; st.textContent = "Pidiéndole a GitHub que mande los avisos…"; st.className = "hint";
    try{
      const r = await fetch("https://api.github.com/repos/"+GH_REPO+"/actions/workflows/avisos-dia.yml/dispatches", {method:"POST",
        headers:{"Authorization":"Bearer "+disc.gh, "Accept":"application/vnd.github+json", "Content-Type":"application/json"}, body: JSON.stringify({ref:"main", inputs:{fecha: todayStr()}})});
      if(r.status!==204){ let m=""; try{ m=(await r.json()).message||""; }catch(e){}
        throw new Error(r.status===401 ? "El token de GitHub no es válido o venció." : r.status===403 ? "El token de GitHub no tiene permiso de Actions (lectura y escritura) en este repositorio." : r.status===404 ? "GitHub no encuentra la tarea avisos-dia.yml: revisá que esté subida en .github/workflows y que el token tenga acceso al repositorio." : (m || "GitHub respondió "+r.status)); }
      try{ await setDoc(doc(db,"privado","discord"), {daySent: todayStr()}, {merge:true}); disc.daySent = todayStr(); }catch(e){}
      busy = false;
      st.innerHTML = 'Listo: GitHub los va a mandar en menos de un minuto. Si no aparecen, mirá la tarea en <a href="https://github.com/'+esc(GH_REPO)+'/actions/workflows/avisos-dia.yml" target="_blank" rel="noopener">GitHub → Actions</a>.';
      btn.remove(); toast("Avisos enviados a GitHub");
    }catch(err){ console.error(err); busy = false; btn.disabled = false; st.textContent = "No se pudo: "+(err instanceof TypeError ? "no hubo conexión con GitHub." : err.message); st.className = "hint warn"; }
  });
}
function botConfigForm(){
  openModal('<form id="bcf"><h2>Avisos del día</h2>'
    + '<div class="hint">El bot manda los mensajes desde GitHub. Su token va como secret en GitHub, no acá (ver la guía).</div>'
    + '<label class="f">ID del canal de los avisos<input type="text" id="f-bchan" inputmode="numeric" autocomplete="off" value="'+esc(disc.chan)+'" placeholder="Ej: 1234567890123456789"></label>'
    + '<label class="f">Reacciones (separadas por espacio)<input type="text" id="f-bemo" autocomplete="off" value="'+esc(disc.emojis)+'" placeholder="✅ 🟡 ❌"><span class="hint">Emojis comunes, o del servidor con el formato &lt;:nombre:id&gt;.</span></label>'
    + '<label class="f">Token de GitHub para el botón<input type="password" id="f-bgh" autocomplete="off" placeholder="'+(disc.gh ? 'Guardado (dejalo vacío para no cambiarlo)' : 'github_pat_…')+'"><span class="hint">Token "fine-grained" con acceso solo a este repositorio y permiso Actions: lectura y escritura. Solo lo ven los capitanes.</span></label>'
    + '<div class="hint" id="bchint"></div>'+foot("")+'</form>');
  document.getElementById("bcf").addEventListener("submit", async e => { e.preventDefault(); if(busy) return;
    const gh = document.getElementById("f-bgh").value.trim(), chan = document.getElementById("f-bchan").value.trim(), emo = document.getElementById("f-bemo").value.trim(), hint = document.getElementById("bchint");
    if(!/^\d{15,25}$/.test(chan)){ hint.textContent = "El ID del canal son solo números (unos 18 o 19). En Discord: clic derecho en el canal → Copiar ID del canal."; hint.className = "hint warn"; return; }
    if(!gh && !disc.gh){ hint.textContent = "Falta el token de GitHub."; hint.className = "hint warn"; return; }
    if(gh && !/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(gh)){ hint.textContent = "Ese no parece un token de GitHub (empieza con github_pat_)."; hint.className = "hint warn"; return; }
    busy = true; setSaving(true);
    try{
      await setDoc(doc(db,"club","discord"), {dayChannel: chan, dayEmojis: emo}, {merge:true});
      if(gh) await setDoc(doc(db,"privado","discord"), {ghToken: gh, botToken: null}, {merge:true});
    }catch(err){ console.error(err); busy = false; setSaving(false); toast(errMsg(err, "No se pudo guardar.")); return; }
    busy = false; if(gh) disc.gh = gh; disc.chan = chan; disc.emojis = emo; closeModal(); toast("Avisos configurados"); render();
  });
}
async function loadDiscord(){
  try{
    const [p, c] = await Promise.all([getDoc(doc(db,"privado","discord")), getDoc(doc(db,"club","discord"))]);
    const pd = p.exists() ? p.data() : {};
    const cd = c.exists() ? c.data() : {};
    disc.hook = pd.calWebhook || ""; disc.gh = pd.ghToken || ""; disc.daySent = pd.daySent || "";
    disc.chan = cd.dayChannel || ""; disc.emojis = cd.dayEmojis!=null ? cd.dayEmojis : "✅ 🟡 ❌";
    disc.msgId = c.exists() ? (c.data().calMsgId || "") : "";
  }catch(e){ console.error(e); }
  disc.loaded = true;
  if(ui.tab==="ligas") render();
  if(disc.hook && disc.msgId) syncDiscord(false, false);
}
let dcTimer = null, dcBusy = false;
function scheduleDiscord(){ if(!canWrite || !disc.hook) return; clearTimeout(dcTimer); dcTimer = setTimeout(() => syncDiscord(false, false), 1500); }
async function syncDiscord(forceNew, loud){
  if(!canWrite || !disc.hook || !S) return;
  if(dcBusy){ scheduleDiscord(); return; }
  dcBusy = true;
  const content = renderCalendario(S, todayStr());
  const body = JSON.stringify({content, allowed_mentions:{parse:[]}});
  try{
    let edited = false;
    if(disc.msgId && !forceNew){
      const r = await fetch(disc.hook+"/messages/"+disc.msgId, {method:"PATCH", headers:{"Content-Type":"application/json"}, body});
      if(r.ok) edited = true; else if(r.status!==404) throw new Error("Discord "+r.status);
    }
    if(!edited){
      const post = JSON.stringify({content, allowed_mentions:{parse:[]}, username: (S.club && S.club.name) || "Dark Empire", avatar_url: new URL("favicon.png", location.href).href});
      const r = await fetch(disc.hook+"?wait=true", {method:"POST", headers:{"Content-Type":"application/json"}, body: post});
      if(!r.ok) throw new Error("Discord "+r.status);
      const j = await r.json(); disc.msgId = String(j.id);
      await setDoc(doc(db,"club","discord"), {calMsgId: disc.msgId});
    }
    disc.last = new Date().toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"});
    if(loud) toast(edited ? "Mensaje de Discord actualizado" : "Mensaje publicado en Discord");
  }catch(e){ console.error(e); toast("No se pudo actualizar el mensaje de Discord. Revisá el webhook en Ligas → Discord."); }
  dcBusy = false;
  if(ui.tab==="ligas") render();
}
function discordConfigForm(){
  openModal('<form id="dcf"><h2>Webhook del calendario</h2>'
    + '<label class="f">Dirección del webhook<input type="text" id="f-dchook" autocomplete="off" placeholder="https://discord.com/api/webhooks/..." value="'+esc(disc.hook)+'"></label>'
    + '<div class="hint" id="dchint">En Discord: Editar canal → Integraciones → Webhooks → Nuevo webhook → Copiar URL. Usá el canal donde va el calendario. Solo los capitanes pueden ver esta dirección.</div>'
    + foot("")+'</form>');
  document.getElementById("dcf").addEventListener("submit", async e => { e.preventDefault(); if(busy) return;
    const url = document.getElementById("f-dchook").value.trim(), hint = document.getElementById("dchint");
    if(!webhookValido(url)){ hint.textContent = "Esa dirección no es un webhook de Discord. Tiene que empezar con https://discord.com/api/webhooks/"; hint.className = "hint warn"; return; }
    busy = true; setSaving(true);
    try{ await setDoc(doc(db,"privado","discord"), {calWebhook: url}, {merge:true}); }
    catch(err){ console.error(err); busy = false; setSaving(false); toast(errMsg(err, "No se pudo guardar el webhook.")); return; }
    busy = false; const changed = url !== disc.hook; disc.hook = url; closeModal(); toast("Webhook guardado");
    syncDiscord(changed || !disc.msgId, true);
  });
}
function discordPreview(){
  const txt = renderCalendario(S, todayStr());
  openModal('<div class="pview"><h2>Mensaje de Discord</h2><div class="hint">Así se ve el texto que se manda (Discord le aplica el formato).</div><pre class="dcpre" id="dcpre">'+esc(txt)+'</pre>'
    + '<div class="mfoot"><button type="button" class="btn ghost" data-act="dc-copy" style="margin-right:auto">Copiar texto</button><button type="button" class="btn" data-act="close">Cerrar</button></div></div>');
}

/* ---------- modales ---------- */
let onDelete = null;
function openModal(html){ modalHost.innerHTML = '<div class="overlay" data-act="close-bg"><div class="modal" role="dialog" aria-modal="true">'+html+'</div></div>';
  const f = modalHost.querySelector("input:not([type=radio]):not([type=checkbox]):not([type=file]),select,textarea"); if(f) f.focus(); }
function closeModal(){ modalHost.innerHTML = ""; onDelete = null; }
function foot(delLabel){ return '<div class="confirm" id="cf" hidden><span>'+delLabel+'</span><div class="acts"><button type="button" class="btn danger small" data-act="del-yes">Sí, borrar</button><button type="button" class="btn ghost small" data-act="del-no">Cancelar</button></div></div>'
  + '<div class="mfoot">'+(delLabel?'<button type="button" class="btn danger" data-act="del-ask" style="margin-right:auto">Borrar</button>':'')+'<button type="button" class="btn ghost" data-act="close">Cancelar</button><button class="btn" type="submit">Guardar</button></div>'; }
function setSaving(on){ const sb = modalHost.querySelector('button[type=submit]'); if(sb){ sb.disabled=on; sb.textContent = on ? "Guardando…" : "Guardar"; } }

function matchForm(m){
  const isNew = !m;
  m = m || {id:uid(), league: selLeagues().length===1 ? selLeagues()[0] : (S.leagues[0]||{}).id, status:"pendiente", lineup:[]};
  const lu = {}; (m.lineup||[]).forEach(r => { lu[r.p]=r; });
  const roster = S.players.filter(p => p.active!==false || lu[p.id]).sort((a,b) => a.name.localeCompare(b.name));
  let removeRec = false;
  const h = '<form id="mf"><h2>'+(isNew?'Nuevo partido':'vs '+esc(m.rival))+'</h2><div class="fields">'
    + '<label class="f">Liga<select id="f-league" required>'+S.leagues.map(l => '<option value="'+esc(l.id)+'"'+(l.id===m.league?' selected':'')+'>'+esc(l.name)+'</option>').join("")+'</select></label>'
    + '<label class="f">Fecha / ronda<input type="text" id="f-round" placeholder="Fecha 3, Cuartos…" value="'+esc(m.round||"")+'"></label>'
    + '<label class="f">Rival<input type="text" id="f-rival" required maxlength="50" value="'+esc(m.rival||"")+'"></label>'
    + '<label class="f">Día<input type="date" id="f-date" value="'+esc(m.date||"")+'"></label>'
    + '<label class="f">Hora<input type="time" id="f-time" value="'+esc(m.time||"")+'"></label>'
    + '</div>'
    + '<div class="hint">¿Se reprogramó y todavía no tiene día? Dejá <b>Día</b> vacío: en Discord va a figurar en PENDIENTES.</div>'
    + '<div class="seg" role="radiogroup" aria-label="Estado"><label><input type="radio" name="st" id="st-p" value="pendiente"'+(m.status!=="jugado"?' checked':'')+'>Pendiente</label><label><input type="radio" name="st" id="st-j" value="jugado"'+(m.status==="jugado"?' checked':'')+'>Jugado</label></div>'
    + '<div class="filein"><span>Grabación del partido (.hbr2)</span>'
    + (m.rec ? '<div class="recbox" id="recnow"><span style="color:var(--ink);font-weight:500">'+esc(m.rec.name)+' · '+kb(m.rec.size||0)+'</span><button type="button" class="btn ghost small" data-act="rec-rm">Quitar</button></div>' : '')
    + '<input type="file" id="f-rec" accept=".hbr2,.hbr,.hbrp"><span class="hint" id="rechint">'+(m.rec?'Elegí otro archivo para reemplazarla.':'Opcional. Hasta 900 KB. Al elegirla, la página lee goles y asistencias sola.')+'</span>'
    + (m.rec ? '<div class="acts"><button type="button" class="btn ghost small" id="an-saved">Analizar la grabación guardada</button></div>' : '')
    + '<div id="anout"></div></div>'
    + '<div id="resblock"'+(m.status==="jugado"?'':' hidden')+' style="display:grid;gap:12px">'
    + '<label class="dftoggle"><input type="checkbox" id="f-df"'+(m.df?' checked':'')+'><span><b>DF</b> · El rival no se presentó (3–0)</span></label>'
    + '<div class="scorein"><label class="f" style="text-align:center"><span>Nosotros</span><input type="number" min="0" max="99" id="f-gf" value="'+(m.gf!=null?+m.gf:"")+'"></label><b style="font:700 28px var(--f-display)">–</b><label class="f" style="text-align:center"><span>Rival</span><input type="number" min="0" max="99" id="f-gc" value="'+(m.gc!=null?+m.gc:"")+'"></label></div>'
    + '<div id="lineupblock" style="display:grid;gap:12px">'+(roster.length ? '<div class="tablewrap"><table class="lineup"><thead><tr><th>Jugador</th><th>Jugó</th><th>Goles</th><th>Asist.</th><th>Pases</th><th>% Acierto</th><th>Figura</th></tr></thead><tbody>'
      + roster.map(p => { const r=lu[p.id], id=esc(p.id), n=esc(p.name); return '<tr data-p="'+id+'"'+(r&&+r.pa?' data-pa="'+(+r.pa)+'"':'')+'><td>'+n+'</td><td><input type="checkbox" id="pl-'+id+'" aria-label="Jugó '+n+'"'+(r?' checked':'')+'></td>'
        + '<td><input type="number" min="0" max="99" id="g-'+id+'" aria-label="Goles de '+n+'" value="'+(r&&+r.g?+r.g:"")+'" placeholder="0"></td>'
        + '<td><input type="number" min="0" max="99" id="a-'+id+'" aria-label="Asistencias de '+n+'" value="'+(r&&+r.a?+r.a:"")+'" placeholder="0"></td>'
        + '<td><input type="number" min="0" max="999" id="ps-'+id+'" aria-label="Pases completados de '+n+'" value="'+(r&&+r.pa?(+r.ps||0):"")+'" placeholder="–"></td>'
        + '<td><input type="number" min="0" max="100" id="pp-'+id+'" aria-label="Porcentaje de pases acertados de '+n+'" value="'+(r&&+r.pa?Math.round(100*(+r.ps||0)/(+r.pa)):"")+'" placeholder="–"></td>'
        + '<td><input type="radio" name="mvp" id="mvp-'+id+'" value="'+id+'" aria-label="Figura: '+n+'"'+(m.mvp===p.id?' checked':'')+'></td></tr>'; }).join("")
      + '</tbody></table></div><div class="hint" id="tally"></div>' : '<div class="hint">Agregá jugadores en Plantel para cargarles goles y asistencias.</div>')+'</div>'
    + '</div>'
    + '<label class="f">Notas<input type="text" id="f-notes" maxlength="200" placeholder="Opcional: sala, árbitro, link del video…" value="'+esc(m.notes||"")+'"></label>'
    + foot(isNew ? "" : "¿Borrar este partido, sus estadísticas y su grabación?") + '</form>';
  openModal(h);
  const form = document.getElementById("mf"), $ = id => document.getElementById(id);
  function tally(){ const el=$("tally"); if(!el) return; let g=0,a=0;
    form.querySelectorAll("tr[data-p]").forEach(tr => { const id=tr.dataset.p; g+=+$("g-"+id).value||0; a+=+$("a-"+id).value||0; });
    const gf=+$("f-gf").value||0;
    el.textContent = "Goles asignados: "+g+" de "+gf+" · Asistencias: "+a+(g>gf?" · Hay más goles asignados que goles del equipo.":"");
    el.className = "hint"+(g>gf?" warn":""); }
  function syncDf(){ const on=$("f-df").checked; $("lineupblock").hidden=on; $("f-gf").disabled=on; $("f-gc").disabled=on;
    if(on){ $("f-gf").value=3; $("f-gc").value=0; } }
  syncDf();
  form.addEventListener("change", e => {
    if(e.target.name==="st") $("resblock").hidden = e.target.value!=="jugado";
    if(e.target.id==="f-df"){ if(!e.target.checked){ $("f-gf").value=""; $("f-gc").value=""; } syncDf(); }
    if(e.target.id==="f-rec"){ const f=e.target.files[0], hint=$("rechint");
      if(f && f.size>MAX_REC){ hint.textContent="Ese archivo pesa "+kb(f.size)+"; el máximo es 900 KB."; hint.className="hint warn"; e.target.value=""; }
      else if(f){ hint.textContent="Se va a subir "+f.name+" ("+kb(f.size)+") al guardar."; hint.className="hint"; f.arrayBuffer().then(b => runAnalysis(new Uint8Array(b))); } }
    tally(); });
  form.addEventListener("input", e => { const t=e.target;
    if(t.id && /^(g|a|ps|pp)-/.test(t.id) && +t.value>0){ const cb=$("pl-"+t.id.replace(/^(g|a|ps|pp)-/,"")); if(cb) cb.checked=true; }
    if(t.name==="mvp"){ const c2=$("pl-"+t.value); if(c2) c2.checked=true; }
    tally(); });
  /* --- analizador de la grabación --- */
  const aliasesToSave = {};   // playerId -> [nicks nuevos para su memoria]
  let an = null;              // {games, inc:[bool], team:[1|2], sure:[bool], map:{nick: playerId|"__none"|""}, kind:{nick: match}}
  async function runAnalysis(bytes){
    const out = $("anout"); if(!out) return;
    out.innerHTML = '<div class="anbox"><b>Analizando la grabación…</b> <span id="anprog">0%</span><div class="hint">La página reproduce el partido por dentro. Tarda unos segundos.</div></div>';
    try{
      const games = await analyzeReplay(bytes, {onProgress: p => { const e=$("anprog"); if(e) e.textContent = Math.round(p*100)+"%"; }});
      if(!$("anout")) return;
      if(!games.length){ $("anout").innerHTML = '<div class="anbox"><div class="hint warn">No encontré ningún partido jugado en esa grabación.</div></div>'; return; }
      an = {games, inc: games.map(g => g.ticks >= 3600 || g.goals.length > 0), team: [], sure: [], map:{}, kind:{}, existing: formHasData() && !$("f-df").checked};
      if(!an.inc.some(Boolean)) an.inc = games.map(() => true);
      matchAll(); pickTeams(); renderAnalysis();
    }catch(err){ console.error(err); const o=$("anout"); if(o) o.innerHTML = '<div class="anbox"><div class="hint warn">'+esc(err.message || "No se pudo analizar la grabación.")+'</div></div>'; }
  }
  const pool = () => roster.map(p => ({id:p.id, name:p.name, aliases:p.aliases||[]}));
  const teamOf = pl => pl.ticks[1] >= pl.ticks[2] ? 1 : 2;
  function matchAll(){
    const names = new Set(); an.games.forEach(g => Object.values(g.players).forEach(pl => names.add(pl.name)));
    names.forEach(n => { const r = matchNick(n, pool()); if(r){ an.map[n] = r.id; an.kind[n] = r; } });
  }
  // De qué color jugamos en cada tramo (en el 2º tiempo suelen cambiar de color).
  function pickTeams(){
    an.games.forEach((g,i) => { const cnt = {1:0, 2:0};
      Object.values(g.players).forEach(pl => { const r = an.kind[pl.name]; if(r && an.map[pl.name]===r.id) cnt[teamOf(pl)] += r.kind==="memoria" ? 2 : 1; });
      an.team[i] = cnt[2] > cnt[1] ? 2 : 1; an.sure[i] = cnt[1] !== cnt[2]; });
    // Tramos sin nicks reconocidos: se deduce por los jugadores que comparten con un tramo ya resuelto.
    an.games.forEach((g,i) => { if(an.sure[i]) return;
      const j = an.games.findIndex((x,k) => an.sure[k]); if(j<0) return;
      const ours = new Set(Object.values(an.games[j].players).filter(pl => teamOf(pl)===an.team[j]).map(pl => pl.name)), cnt = {1:0, 2:0};
      Object.values(g.players).forEach(pl => { if(ours.has(pl.name)) cnt[teamOf(pl)]++; });
      if(cnt[1] !== cnt[2]){ an.team[i] = cnt[2] > cnt[1] ? 2 : 1; an.sure[i] = true; } });
  }
  function totals(){
    let gf = 0, gc = 0, ticks = 0; const pl = {}, notes = []; let sinAutor = 0;
    an.games.forEach((g,i) => { if(!an.inc[i]) return; const t = an.team[i];
      gf += t===1 ? g.red : g.blue; gc += t===1 ? g.blue : g.red; ticks += g.ticks;
      Object.values(g.players).forEach(p => { if(teamOf(p)!==t) return; const o = pl[p.name] || (pl[p.name] = {name:p.name, ticks:0, g:0, a:0, ps:0, pa:0}); o.ticks += p.ticks[t];
        const q = (g.passes||{})[p.name]; if(q && !o["seen"+i]){ o["seen"+i] = true; o.ps += q.done; o.pa += q.tried; } });
      g.goals.forEach(x => {
        if(x.own) notes.push((x.team===t ? 'Gol a favor en contra de ' : 'Gol en contra de ')+esc(x.own.name)+' ('+fmtT(x.time)+')');
        if(x.team!==t) return;
        if(x.scorer){ (pl[x.scorer.name] = pl[x.scorer.name] || {name:x.scorer.name, ticks:0, g:0, a:0, ps:0, pa:0}).g++; } else if(!x.own) sinAutor++;
        if(x.assist){ (pl[x.assist.name] = pl[x.assist.name] || {name:x.assist.name, ticks:0, g:0, a:0, ps:0, pa:0}).a++; }
      }); });
    const min = Math.max(180, ticks*0.08);
    const players = Object.values(pl).filter(p => p.ticks >= min || p.g || p.a).sort((a,b) => b.ticks - a.ticks);
    return {gf, gc, players, notes, sinAutor};
  }
  const fmtT = t => { t = Math.max(0, Math.round(t||0)); return Math.floor(t/60)+":"+String(t%60).padStart(2,"0"); };
  function renderAnalysis(){
    const T = totals();
    const opts = sel => '<option value="">¿Quién es?</option>'+roster.map(p => '<option value="'+esc(p.id)+'"'+(sel===p.id?' selected':'')+'>'+esc(p.name)+'</option>').join("")+'<option value="__none"'+(sel==="__none"?' selected':'')+'>No es del club</option>';
    let h = '<div class="anbox"><b>Grabación analizada</b>' + (an.existing ? '<div id="andiff-slot"></div>' : '');
    h += '<div class="anparts">'+an.games.map((g,i) => '<div class="anpart'+(an.inc[i]?'':' off')+'">'
        + '<label class="anchk"><input type="checkbox" class="an-inc" data-i="'+i+'"'+(an.inc[i]?' checked':'')+'> '+(an.games.length>1 ? (i+1)+'º tramo' : 'Partido')+' · '+fmtT(g.ticks/60)+'</label>'
        + '<span class="anscore"><span class="anteam red">Rojo '+g.red+'</span> – <span class="anteam blue">'+g.blue+' Azul</span></span>'
        + '<span class="anrow">Somos <span class="seg small"><label><input type="radio" name="an-team-'+i+'" data-i="'+i+'" value="1"'+(an.team[i]===1?' checked':'')+'>Rojo</label><label><input type="radio" name="an-team-'+i+'" data-i="'+i+'" value="2"'+(an.team[i]===2?' checked':'')+'>Azul</label></span>'
        + (an.sure[i] ? '' : '<span class="hint warn">Elegí el color</span>')+'</span></div>').join("")+'</div>';
    h += '<div class="antotal">Resultado: <b>'+T.gf+' – '+T.gc+'</b>'+(an.games.length>1 ? ' <span class="hint">(suma de los tramos marcados)</span>' : '')+'</div>';
    h += '<div class="tablewrap"><table class="antable"><thead><tr><th>Nick en la grabación</th><th>Jugador del club</th><th>G</th><th>A</th><th>Pases</th><th>%</th></tr></thead><tbody>'
      + (T.players.length ? T.players.map(pl => { const k = an.kind[pl.name], sel = an.map[pl.name] || "";
          const tag = !sel ? '<span class="antag ask">Asignar</span>' : sel==="__none" ? '' : k && k.kind==="memoria" && k.id===sel ? '<span class="antag ok">Reconocido</span>' : k && k.id===sel ? '<span class="antag sim">'+(k.ambiguous?'Revisar':'Parecido')+'</span>' : '<span class="antag man">Elegido</span>';
          return '<tr><td>'+esc(pl.name)+' '+tag+'</td><td><select class="an-map" data-nick="'+esc(pl.name)+'" aria-label="Jugador del club para '+esc(pl.name)+'">'+opts(sel)+'</select></td><td>'+pl.g+'</td><td>'+pl.a+'</td><td class="num">'+pl.ps+'</td><td class="num">'+(pl.pa?Math.round(100*pl.ps/pl.pa)+'%':'—')+'</td></tr>'; }).join("")
        : '<tr><td colspan="6" class="hint">No hay jugadores de nuestro equipo en los tramos marcados.</td></tr>')
      + '</tbody></table></div>';
    if(T.notes.length || T.sinAutor) h += '<div class="hint">'+T.notes.join(' · ')+(T.sinAutor ? (T.notes.length?' · ':'')+T.sinAutor+' gol(es) sin autor detectado.' : '')+'</div>';
    const missing = T.players.filter(pl => !an.map[pl.name]).length;
    const warnMissing = missing ? '<span class="hint warn">Faltan '+missing+' nick'+(missing>1?'s':'')+' por asignar. Si no los asignás, sus goles no se suman.</span>' : '';
    if(an.existing){
      an.changes = buildChanges(T);
      let d = '<div class="andiff"><b>Este partido ya tenía datos cargados.</b> '
        + (an.changes.length ? 'Encontré <b>'+an.changes.length+'</b> diferencia'+(an.changes.length>1?'s':'')+'. Marcá las que querés aceptar:' : 'Lo que dice la grabación coincide con lo cargado: no hay cambios.')
        + (an.changes.length ? '<ul class="anchanges">'+an.changes.map((c,i) => '<li><label><input type="checkbox" class="an-chg" data-i="'+i+'"'+(c.on?' checked':'')+'> '+c.label+'</label></li>').join("")+'</ul>' : '')
        + '<div class="acts">'+(an.changes.length ? '<button type="button" class="btn small" id="an-accept">Aceptar los marcados</button><button type="button" class="btn ghost small" id="an-reject">Rechazar todos</button>' : '')+warnMissing+'</div>'
        + '<div class="hint">Si algún nick está mal asignado, corregilo en la tabla de abajo y la lista se actualiza.</div></div>';
      h = h.replace('<div id="andiff-slot"></div>', d);
    } else {
      h += '<div class="acts"><button type="button" class="btn small" id="an-apply">Cargar resultado y estadísticas ('+T.gf+'–'+T.gc+')</button>'+warnMissing+'</div>';
    }
    h += '<div class="hint">La figura no se detecta sola: elegila vos en la tabla de jugadores.</div></div>';
    $("anout").innerHTML = h;
  }
  // ¿El formulario ya tiene resultado o estadísticas cargadas?
  function formHasData(){
    if($("f-gf").value!=="" || $("f-gc").value!=="") return true;
    return [...form.querySelectorAll("tr[data-p]")].some(tr => $("pl-"+tr.dataset.p).checked);
  }
  // Lo que dice la grabación, por jugador del club.
  function targetVals(T){
    const v = {};
    T.players.forEach(pl => { const pid = an.map[pl.name]; if(!pid || pid==="__none" || !$("pl-"+pid)) return;
      const o = v[pid] || (v[pid] = {g:0, a:0, ps:0, pa:0, nicks:[]}); o.g += pl.g; o.a += pl.a; o.ps += pl.ps; o.pa += pl.pa; o.nicks.push(pl.name); });
    return v;
  }
  function curVals(pid){
    const tr = form.querySelector('tr[data-p="'+pid+'"]'), ps = $("ps-"+pid).value, pp = $("pp-"+pid).value;
    return {played: $("pl-"+pid).checked, g: +$("g-"+pid).value||0, a: +$("a-"+pid).value||0,
      ps: ps==="" ? null : +ps, pp: pp==="" ? null : +pp, pa: +tr.dataset.pa||0};
  }
  const pasesTxt = (ps, pp) => ps==null ? '—' : ps+(pp!=null ? ' ('+pp+'%)' : '');
  const arrow = (x, y) => '<span class="anold">'+x+'</span> → <b>'+y+'</b>';
  function buildChanges(T){
    const ch = [], tv = targetVals(T);
    const gf = $("f-gf").value, gc = $("f-gc").value;
    if(+gf!==T.gf || +gc!==T.gc || gf==="" || gc==="")
      ch.push({on:true, label:'Resultado: '+arrow((gf===""?"–":gf)+'–'+(gc===""?"–":gc), T.gf+'–'+T.gc), apply:() => { $("f-gf").value=T.gf; $("f-gc").value=T.gc; }});
    roster.forEach(p => { const pid = p.id; if(!$("pl-"+pid)) return;
      const c = curVals(pid), t = tv[pid], name = '<b>'+esc(p.name)+'</b>';
      if(t){
        if(!c.played) ch.push({on:true, label:name+': jugó '+arrow('no','sí'), apply:() => { $("pl-"+pid).checked = true; }});
        if(c.g!==t.g) ch.push({on:true, label:name+': goles '+arrow(c.g, t.g), apply:() => { $("pl-"+pid).checked = true; $("g-"+pid).value = t.g || ""; }});
        if(c.a!==t.a) ch.push({on:true, label:name+': asistencias '+arrow(c.a, t.a), apply:() => { $("pl-"+pid).checked = true; $("a-"+pid).value = t.a || ""; }});
        const tpp = t.pa ? Math.round(100*t.ps/t.pa) : null;
        if(t.pa && (c.ps!==t.ps || c.pp!==tpp)) ch.push({on:true, label:name+': pases '+arrow(pasesTxt(c.ps, c.pp), pasesTxt(t.ps, tpp)), apply:() => {
          $("pl-"+pid).checked = true; $("ps-"+pid).value = t.ps; $("pp-"+pid).value = tpp; form.querySelector('tr[data-p="'+pid+'"]').dataset.pa = t.pa; }});
      } else if(c.played){
        // Cargado como que jugó, pero en la grabación no aparece (o su nick no está asignado): no se marca por defecto.
        ch.push({on:false, label:name+': jugó '+arrow('sí','no')+(c.g||c.a ? ' (se le borrarían '+c.g+' G y '+c.a+' A)' : '')+' <span class="hint">· no aparece en la grabación</span>', apply:() => {
          $("pl-"+pid).checked = false; $("g-"+pid).value=""; $("a-"+pid).value=""; $("ps-"+pid).value=""; $("pp-"+pid).value=""; delete form.querySelector('tr[data-p="'+pid+'"]').dataset.pa; }});
      }
    });
    return ch;
  }
  function rememberNicks(T){
    for(const k in aliasesToSave) delete aliasesToSave[k];
    T.players.forEach(pl => { const pid = an.map[pl.name]; if(!pid || pid==="__none" || !$("pl-"+pid)) return;
      const p = P(pid), r = matchNick(pl.name, [{id:pid, name:p.name, aliases:p.aliases||[]}]);
      if(!(r && r.kind==="memoria")) (aliasesToSave[pid] = aliasesToSave[pid] || []).push(pl.name); });
    return Object.values(aliasesToSave).reduce((x,y) => x+y.length, 0);
  }
  function acceptChanges(){
    const T = totals(), picked = an.changes.filter((c,i) => { const el = form.querySelector('.an-chg[data-i="'+i+'"]'); return el && el.checked; });
    $("st-j").checked = true; $("resblock").hidden = false;
    if($("f-df").checked){ $("f-df").checked = false; syncDf(); }
    picked.forEach(c => c.apply());
    const n = rememberNicks(T);
    tally();
    $("anout").innerHTML = '<div class="anbox"><b>'+picked.length+' cambio'+(picked.length===1?'':'s')+' aplicado'+(picked.length===1?'':'s')+'.</b><div class="hint">Revisá la tabla de jugadores y tocá Guardar para que quede guardado.'+(n ? ' Se van a recordar '+n+' nick'+(n>1?'s':'')+' nuevo'+(n>1?'s':'')+'.' : '')+'</div></div>';
    $("lineupblock").scrollIntoView({behavior:"smooth", block:"start"});
  }
  function applyAnalysis(){
    const T = totals();
    $("st-j").checked = true; $("resblock").hidden = false;
    if($("f-df").checked){ $("f-df").checked = false; syncDf(); }
    $("f-gf").value = T.gf; $("f-gc").value = T.gc;
    form.querySelectorAll("tr[data-p]").forEach(tr => { const id=tr.dataset.p; $("pl-"+id).checked=false; $("g-"+id).value=""; $("a-"+id).value=""; $("ps-"+id).value=""; $("pp-"+id).value=""; delete tr.dataset.pa; });
    for(const k in aliasesToSave) delete aliasesToSave[k];
    T.players.forEach(pl => { const pid = an.map[pl.name]; if(!pid || pid==="__none" || !$("pl-"+pid)) return;
      $("pl-"+pid).checked = true;
      $("g-"+pid).value = ((+$("g-"+pid).value||0) + pl.g) || "";
      $("a-"+pid).value = ((+$("a-"+pid).value||0) + pl.a) || "";
      const row = form.querySelector('tr[data-p="'+pid+'"]'), tps = (+$("ps-"+pid).value||0) + pl.ps, tpa = (+row.dataset.pa||0) + pl.pa;
      $("ps-"+pid).value = tps; row.dataset.pa = tpa; $("pp-"+pid).value = tpa ? Math.round(100*tps/tpa) : "";
      const p = P(pid), r = matchNick(pl.name, [{id:pid, name:p.name, aliases:p.aliases||[]}]);
      if(!(r && r.kind==="memoria")) (aliasesToSave[pid] = aliasesToSave[pid] || []).push(pl.name);
    });
    tally();
    const n = Object.values(aliasesToSave).reduce((a,b) => a+b.length, 0);
    toast("Datos cargados. Revisalos y tocá Guardar."+(n ? " Se van a recordar "+n+" nick"+(n>1?"s":"")+" nuevo"+(n>1?"s":"")+"." : ""));
    $("lineupblock").scrollIntoView({behavior:"smooth", block:"start"});
  }
  form.addEventListener("change", e => {
    if(!an) return; const t = e.target;
    if(t.classList.contains("an-map")){ an.map[t.dataset.nick] = t.value; renderAnalysis(); }
    if(t.classList.contains("an-inc")){ an.inc[+t.dataset.i] = t.checked; renderAnalysis(); }
    if(t.name && t.name.startsWith("an-team-")){ an.team[+t.dataset.i] = +t.value; an.sure[+t.dataset.i] = true; renderAnalysis(); }
  });
  form.addEventListener("click", async e => {
    if(e.target.id==="an-apply"){ applyAnalysis(); return; }
    if(e.target.id==="an-accept"){ acceptChanges(); return; }
    if(e.target.id==="an-reject"){ $("anout").innerHTML = '<div class="anbox"><b>No se cambió nada.</b><div class="hint">Los datos del partido quedan como estaban.</div></div>'; return; }
    if(e.target.id==="an-saved" && m.rec){ e.target.disabled = true;
      try{ const snap = await getDoc(doc(db,"grabaciones",m.rec.id)); if(!snap.exists()) throw new Error("No se encontró la grabación guardada."); runAnalysis(snap.data().data.toUint8Array()); }
      catch(err){ toast(err.message || "No se pudo leer la grabación guardada."); }
      e.target.disabled = false; }
  });
  form.addEventListener("click", e => { if(e.target.closest('[data-act="rec-rm"]')){ removeRec = true; $("recnow").remove(); $("rechint").textContent = "La grabación se va a quitar al guardar."; } });
  tally();
  onDelete = async () => {
    const ok = await commit(n => { n.matches = n.matches.filter(x => x.id!==m.id); }, "Partido borrado");
    if(ok && m.rec) deleteDoc(doc(db,"grabaciones",m.rec.id)).catch(()=>{});
  };
  form.addEventListener("submit", async e => { e.preventDefault(); if(busy) return;
    const st = form.querySelector('input[name="st"]:checked').value;
    const nm = {id:m.id, league:$("f-league").value, round:$("f-round").value.trim(), rival:$("f-rival").value.trim(),
      date:$("f-date").value, time:$("f-time").value, notes:$("f-notes").value.trim(), status:st, rec: removeRec ? null : (m.rec||null)};
    if(!nm.rival){ $("f-rival").focus(); return; }
    nm.df = st==="jugado" && $("f-df").checked;
    if(nm.df){ nm.gf = 3; nm.gc = 0; nm.lineup = []; nm.mvp = null; }
    else if(st==="jugado"){
      nm.gf = Math.max(0, +$("f-gf").value||0); nm.gc = Math.max(0, +$("f-gc").value||0);
      nm.lineup = []; form.querySelectorAll("tr[data-p]").forEach(tr => { const id=tr.dataset.p;
        const g=Math.max(0,+$("g-"+id).value||0), a=Math.max(0,+$("a-"+id).value||0);
        // Pases: se guardan acertados (ps) e intentados (pa). El % que se ve sale de ahí; los intentos no se muestran.
        const psRaw=$("ps-"+id).value, ppRaw=$("pp-"+id).value; let ps=null, pa=null;
        if(psRaw!=="" && ppRaw!==""){ ps=Math.max(0,+psRaw||0); const pp=Math.min(100,Math.max(0,+ppRaw||0)), dpa=+tr.dataset.pa||0;
          if(dpa && dpa>=ps && Math.round(100*ps/dpa)===pp) pa=dpa; else if(pp>0) pa=Math.max(ps, Math.round(ps*100/pp)); else pa=dpa||null; }
        if($("pl-"+id).checked || g || a){ const row={p:id,g,a}; if(pa){ row.ps=ps; row.pa=pa; } nm.lineup.push(row); } });
      const mv = form.querySelector('input[name="mvp"]:checked'); nm.mvp = mv ? mv.value : null;
    } else { nm.lineup = m.lineup || []; nm.mvp = m.mvp || null; nm.gf = m.gf ?? null; nm.gc = m.gc ?? null; }
    const file = $("f-rec").files[0];
    const oldRec = m.rec;
    if(file){
      busy = true; setSaving(true);
      try{
        const buf = new Uint8Array(await file.arrayBuffer());
        const recId = uid();
        await setDoc(doc(db,"grabaciones",recId), {data: Bytes.fromUint8Array(buf), name: file.name.slice(0,80), size: buf.length, match: m.id});
        nm.rec = {id: recId, name: file.name.slice(0,80), size: buf.length};
      }catch(err){ console.error(err); busy=false; setSaving(false); toast(errMsg(err, "No se pudo subir la grabación.")); return; }
      busy = false;
    }
    const ok = await commit(n => { const i=n.matches.findIndex(x => x.id===nm.id); if(i<0) n.matches.push(nm); else n.matches[i]=nm;
        if(st==="jugado") for(const pid in aliasesToSave){ const p = n.players.find(x => x.id===pid); if(!p) continue;
          const have = new Set([p.name, ...(p.aliases||[])].map(x => String(x).toLowerCase()));
          p.aliases = (p.aliases||[]).concat(aliasesToSave[pid].filter(a => !have.has(String(a).toLowerCase()))).slice(-30); } },
      isNew ? "Partido agregado al fixture" : (nm.df ? "Guardado como DF (3–0)" : st==="jugado" ? "Resultado guardado" : "Partido actualizado"));
    if(ok && oldRec && (!nm.rec || nm.rec.id!==oldRec.id)) deleteDoc(doc(db,"grabaciones",oldRec.id)).catch(()=>{});
    if(!ok && file && nm.rec) deleteDoc(doc(db,"grabaciones",nm.rec.id)).catch(()=>{});
  });
}
function playerView(p){
  const ms = played(S.matches).filter(m => !m.df && (m.lineup||[]).some(r => r.p===p.id));
  let g=0,a=0,f=0,ps=0,pa=0;
  const rows = ms.map(m => { const r=(m.lineup||[]).find(x => x.p===p.id), x=res(m); g+=+r.g||0; a+=+r.a||0; if(m.mvp===p.id) f++; if(+r.pa){ ps+=+r.ps||0; pa+=+r.pa; }
    const bits = [];
    if(+r.g) bits.push('<b>'+(+r.g)+'</b> '+(+r.g===1?'gol':'goles'));
    if(+r.a) bits.push('<b>'+(+r.a)+'</b> '+(+r.a===1?'asist.':'asist.'));
    if(+r.pa) bits.push('<b>'+(+r.ps||0)+'</b> pases ('+Math.round(100*(+r.ps||0)/(+r.pa))+'%)');
    if(m.mvp===p.id) bits.push('<span class="mvptag">Figura</span>');
    return '<li class="pm'+(bits.length?' hit':'')+'"><div class="mdate"><b>'+esc(fmtDate(m.date))+'</b></div>'
      + '<div style="min-width:0"><div class="mmeta">'+lgBadge(m.league)+(m.round?' · '+esc(m.round):'')+'</div><div class="mrival">vs '+esc(m.rival)+'</div>'
      + '<div class="contrib">'+(bits.join(' · ')||'<span class="hint">Sin goles ni asistencias</span>')+'</div></div>'
      + '<div class="score small num '+x+'">'+(+m.gf)+'–'+(+m.gc)+'</div></li>'; }).join("");
  const pos = posList(p).map(k => POS[k]).join(" · ");
  openModal('<div class="pview"><h2 style="display:flex;align-items:center;gap:10px"><span class="shirt num">'+esc(p.num||"·")+'</span>'+esc(p.name)+'</h2>'
    + '<div class="hint">'+esc(pos||"Sin posición")+(p.active===false?' · De baja':'')+'</div>'
    + '<div class="record num">'+rec(ms.length,"PJ")+rec(g,"Goles")+rec(a,"Asist.")+rec(f,"Figura")+(pa ? rec(ps,"Pases")+rec(Math.round(100*ps/pa)+"%","Acierto") : '')+'</div>'
    + (ms.length ? '<h3 class="pvh">Partidos jugados</h3><ul class="plist">'+rows+'</ul>' : '<div class="empty">Todavía no tiene partidos cargados.</div>')
    + '<div class="mfoot">'+(canWrite?'<button type="button" class="btn ghost" data-act="p-edit" data-id="'+esc(p.id)+'" style="margin-right:auto">Editar jugador</button>':'')+'<button type="button" class="btn" data-act="close">Cerrar</button></div></div>');
}
function playersNewForm(){
  openModal('<form id="pf"><h2>Agregar jugadores</h2><label class="f">Un nick por línea<textarea id="f-names" placeholder="Pepe&#10;ElTanque&#10;Zurdo10"></textarea></label><div class="hint">Después podés tocar cada jugador para ponerle posición y número.</div>'+foot("")+'</form>');
  document.getElementById("pf").addEventListener("submit", e => { e.preventDefault();
    const raw = document.getElementById("f-names").value.split(/\n/).map(s => s.trim().slice(0,40)).filter(Boolean);
    if(!raw.length){ closeModal(); return; }
    commit(n => { const have = new Set(n.players.map(p => p.name.toLowerCase()));
      raw.forEach(nm => { if(have.has(nm.toLowerCase())) return; have.add(nm.toLowerCase()); n.players.push({id:uid(),name:nm,pos:"",num:"",active:true}); }); },
      raw.length===1 ? "Jugador agregado" : "Jugadores agregados"); });
}
function playerForm(p){
  const t = stats(S.matches)[p.id], hasStats = t.pj>0 || S.matches.some(m => m.mvp===p.id);
  openModal('<form id="pe"><h2>'+esc(p.name)+'</h2><div class="fields">'
    + '<label class="f">Nick<input type="text" id="f-pname" required maxlength="40" value="'+esc(p.name)+'"></label>'
        + '<label class="f">Avatar<input type="text" id="f-num" maxlength="6" autocomplete="off" placeholder="Ej: 10, ☠, DE" value="'+esc(p.num||"")+'"></label></div>'
    + '<label class="f">Nicks que usa en Haxball<input type="text" id="f-aliases" maxlength="400" autocomplete="off" placeholder="Ej: petr, pet, cech" value="'+esc((p.aliases||[]).join(", "))+'"><span class="hint">Separados por coma. El analizador de grabaciones los usa para reconocerlo, y suma solo los nicks nuevos que le asignes.</span></label>'
    + '<div class="filein"><span>Posiciones (podés marcar varias)</span><div class="chips poschk" role="group" aria-label="Posiciones">'+Object.keys(POS).map(k => '<label class="chip"><input type="checkbox" name="pos" id="pos-'+k+'" value="'+k+'"'+(posList(p).includes(k)?' checked':'')+'>'+POS[k]+'</label>').join("")+'</div></div>'
    + '<div class="seg" role="radiogroup" aria-label="Estado"><label><input type="radio" name="ac" id="ac-1" value="1"'+(p.active!==false?' checked':'')+'>En el plantel</label><label><input type="radio" name="ac" id="ac-0" value="0"'+(p.active===false?' checked':'')+'>De baja</label></div>'
    + (hasStats ? '<div class="hint">Tiene estadísticas cargadas: si se va del club, dalo de baja en vez de borrarlo así no se pierden.</div>' : '')
    + foot(hasStats ? "Borrarlo también saca sus goles y asistencias de las estadísticas. ¿Seguro?" : "¿Borrar a este jugador?")+'</form>');
  const form=document.getElementById("pe");
  onDelete = () => commit(n => { n.players=n.players.filter(x => x.id!==p.id);
    n.matches.forEach(m => { if(m.lineup) m.lineup=m.lineup.filter(r => r.p!==p.id); if(m.mvp===p.id) m.mvp=null; }); }, "Jugador borrado");
  form.addEventListener("submit", e => { e.preventDefault(); const nm=document.getElementById("f-pname").value.trim(); if(!nm) return;
    const upd={name:nm, pos:[...form.querySelectorAll('input[name="pos"]:checked')].map(x => x.value), num:document.getElementById("f-num").value.trim(), active: form.querySelector('input[name="ac"]:checked').value==="1", aliases: [...new Set(document.getElementById("f-aliases").value.split(",").map(x => x.trim()).filter(Boolean))].slice(0,30)};
    commit(n => { const x = n.players.find(x => x.id===p.id); if(x) Object.assign(x, upd); }, "Jugador actualizado"); });
}
function leagueForm(l){
  const isNew=!l; l = l || {id:uid(), name:"", note:"", color: COLORS[S.leagues.length % COLORS.length]};
  const used = S.matches.filter(m => m.league===l.id).length;
  openModal('<form id="lf"><h2>'+(isNew?'Nueva liga':esc(l.name))+'</h2><div class="fields">'
    + '<label class="f">Nombre<input type="text" id="f-lname" required maxlength="40" value="'+esc(l.name)+'" placeholder="Liga Argentina de Haxball"></label>'
    + '<label class="f">Detalle<input type="text" id="f-lnote" maxlength="60" value="'+esc(l.note||"")+'" placeholder="División, torneo, temporada…"></label>'
    + '<label class="f">Nombre corto (Discord)<input type="text" id="f-lshort" maxlength="20" value="'+esc(l.short||"")+'" placeholder="Ej: RF"></label>'
    + '<label class="f">Rol de Discord (ID)<input type="text" id="f-lrole" inputmode="numeric" autocomplete="off" maxlength="25" value="'+esc(l.role||"")+'" placeholder="Ej: 1234567890123456789"></label>'
    + '<label class="f">Modalidad<select id="f-lgroup"><option value="">Sin modalidad</option>'+S.groups.map(g => '<option value="'+esc(g.id)+'"'+(l.group===g.id?' selected':'')+'>'+esc(g.name)+'</option>').join("")+'<option value="__new">+ Nueva modalidad…</option></select></label>'
    + '<label class="f" id="f-lgnew-wrap" hidden>Nombre de la nueva modalidad<input type="text" id="f-lgnew" maxlength="30" placeholder="Ej: x7"></label></div>'
    + '<label class="f">Link de la tabla de posiciones<input type="text" id="f-llink" autocomplete="off" maxlength="300" inputmode="url" value="'+esc(l.link||"")+'" placeholder="https://challenge.place/c/..."><span class="hint" id="llhint">Opcional. Pegá el link de la liga en challenge.place (o donde publiquen la tabla).</span></label>'
    + '<div class="filein"><span>Color</span><div class="swatches" role="radiogroup" aria-label="Color">'+COLORS.map((c,i) => '<label class="swatch" style="--sw:'+c+'" title="'+c+'"><input type="radio" name="lc" id="lc-'+i+'" value="'+c+'"'+(c===l.color?' checked':'')+' aria-label="Color '+(i+1)+'"></label>').join("")
    + '<label class="swatch custom" title="Elegir otro color"><input type="radio" name="lc" id="lc-x" value="custom"'+(COLORS.includes(l.color)?'':' checked')+' aria-label="Otro color"><input type="color" id="f-lcolor" value="'+(COLORS.includes(l.color)||!/^#[0-9a-f]{6}$/i.test(l.color||"")?'#888888':esc(l.color))+'" aria-label="Elegir otro color"><span>Otro</span></label></div></div>'
    + (used ? '<div class="hint">Tiene '+used+' partido'+(used===1?'':'s')+'. Para borrarla, primero borrá esos partidos o pasalos a otra liga.</div>' : '')
    + foot(isNew||used ? "" : "¿Borrar esta liga?")+'</form>');
  const form=document.getElementById("lf");
  document.getElementById("f-lcolor").addEventListener("input", () => { document.getElementById("lc-x").checked = true; });
  document.getElementById("f-lgroup").addEventListener("change", e => { const w = document.getElementById("f-lgnew-wrap"); w.hidden = e.target.value!=="__new"; if(!w.hidden) document.getElementById("f-lgnew").focus(); });
  onDelete = () => commit(n => { n.leagues=n.leagues.filter(x => x.id!==l.id); }, "Liga borrada");
  form.addEventListener("submit", e => { e.preventDefault(); const nm=document.getElementById("f-lname").value.trim(); if(!nm) return;
    const c=form.querySelector('input[name="lc"]:checked'); const pick = c && c.value==="custom" ? document.getElementById("f-lcolor").value : (c ? c.value : l.color); const color = /^#[0-9a-f]{6}$/i.test(pick) ? pick : l.color; let rawLink=document.getElementById("f-llink").value.trim(); if(rawLink && !/^[a-z]+:/i.test(rawLink)) rawLink="https://"+rawLink; const link=rawLink?safeUrl(rawLink):"";
    if(rawLink && !link){ const hh=document.getElementById("llhint"); hh.textContent="Ese link no es válido: tiene que empezar con https://"; hh.className="hint warn"; document.getElementById("f-llink").focus(); return; }
    let gsel = document.getElementById("f-lgroup").value, newG = null;
    if(gsel==="__new"){ const gn = document.getElementById("f-lgnew").value.trim(); if(!gn){ document.getElementById("f-lgnew").focus(); return; }
      const ex = S.groups.find(x => x.name.toLowerCase()===gn.toLowerCase()); if(ex) gsel = ex.id; else { newG = {id:uid(), name:gn}; gsel = newG.id; } }
    const nl={id:l.id,name:nm,note:document.getElementById("f-lnote").value.trim(),short:document.getElementById("f-lshort").value.trim(),color,link};
    const role = document.getElementById("f-lrole").value.trim().replace(/[<@&>]/g,"");
    if(role && !/^\d{15,25}$/.test(role)){ toast("El rol de Discord tiene que ser el ID (solo números). Clic derecho en el rol → Copiar ID del rol."); document.getElementById("f-lrole").focus(); return; }
    if(role) nl.role = role;
    if(gsel) nl.group = gsel;
    commit(n => { if(newG){ n.groups = n.groups || []; n.groups.push(newG); } const i=n.leagues.findIndex(x => x.id===nl.id); if(i<0) n.leagues.push(nl); else n.leagues[i]=nl; }, isNew?"Liga creada":"Liga actualizada"); });
}
function clubForm(){
  openModal('<form id="cfm"><h2>Nombre del club</h2><label class="f">Nombre<input type="text" id="f-club" required maxlength="40" value="'+esc(S.club.name)+'"></label>'+foot("")+'</form>');
  document.getElementById("cfm").addEventListener("submit", e => { e.preventDefault(); const nm=document.getElementById("f-club").value.trim(); if(!nm) return;
    commit(n => { n.club.name=nm; }, "Nombre actualizado"); });
}

/* ---------- grabaciones ---------- */
async function downloadRec(m){
  try{
    toast("Descargando grabación…");
    const snap = await getDoc(doc(db,"grabaciones",m.rec.id));
    if(!snap.exists()){ toast("No se encontró la grabación."); return; }
    const d = snap.data(), blob = new Blob([d.data.toUint8Array()], {type:"application/octet-stream"});
    const safe = s => String(s||"").replace(/[^\w\-]+/g,"_").replace(/^_+|_+$/g,"");
    let name = d.name || ("vs_"+safe(m.rival)+(m.date?"_"+m.date:"")+".hbr2");
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }catch(e){ console.error(e); toast("No se pudo descargar. Probá de nuevo."); }
}

/* ---------- guardar ---------- */
function errMsg(err, fallback){
  const c = err && err.code || "";
  if(c.includes("permission-denied")) return "Tu cuenta no tiene permiso para editar.";
  if(c.includes("unavailable")) return "Sin conexión. Revisá internet y volvé a guardar.";
  if(c.includes("resource-exhausted")) return "Se llegó al límite diario gratis de Firebase. Mañana vuelve a funcionar.";
  return fallback;
}
async function commit(mut, msg){
  if(!canWrite || busy) return false;
  busy = true; setSaving(true);
  try{
    await runTransaction(db, async tx => {
      const snap = await tx.get(mainRef);
      const next = JSON.parse(JSON.stringify(normalize(snap.exists() ? snap.data() : EMPTY())));
      mut(next);
      tx.set(mainRef, JSON.parse(JSON.stringify(next)));
    });
    busy = false; closeModal(); toast(msg); scheduleDiscord(); return true;
  }catch(err){
    console.error(err); busy = false; setSaving(false); toast(errMsg(err, "No se pudo guardar. Probá de nuevo.")); return false;
  }
}

/* ---------- eventos ---------- */
document.addEventListener("click", e => {
  const el = e.target.closest("[data-act]"); if(!el) return;
  const a = el.dataset.act, id = el.dataset.id;
  if(a==="close-bg"){ if(e.target===el) closeModal(); return; }
  if(a==="close"){ closeModal(); return; }
  if(a==="del-ask"){ document.getElementById("cf").hidden=false; return; }
  if(a==="del-no"){ document.getElementById("cf").hidden=true; return; }
  if(a==="del-yes"){ if(onDelete) onDelete(); return; }
  if(a==="flt-toggle"){ ui.fOpen = !ui.fOpen; render(); return; }
  if(a==="flt-clear"){ if(ui.tab==="estadisticas" && ui.statMode==="grupo") ui.groups = []; else ui.leagues = []; saveUi(); render(); return; }
  if(a==="g-new"){ if(canWrite) groupForm(null); return; }
  if(a==="g-edit"){ if(canWrite) groupForm(G(id)); return; }
  if(a==="sort"){ ui.sort=id; saveUi(); render(); return; }
  if(a==="cal"){ if(id==="0") ui.cal = todayStr().slice(0,7); else { const [yy,mm]=ui.cal.split("-").map(Number); const dt=new Date(Date.UTC(yy,mm-1+Number(id),1)); ui.cal = dt.getUTCFullYear()+"-"+String(dt.getUTCMonth()+1).padStart(2,"0"); } render(); return; }
  if(a==="m-report"){ const m=S.matches.find(x => x.id===id); if(m && canWrite) reportModal(m); return; }
  if(a==="m-view"){ const m=S.matches.find(x => x.id===id); if(m) matchModal(m); return; }
  if(a==="m-open"){ ui.open = ui.open===id ? null : id; render(); return; }
  if(a==="rec-dl"){ const m = S.matches.find(x => x.id===id); if(m && m.rec) downloadRec(m); return; }
  if(a==="p-view"){ const p=P(id); if(p) playerView(p); return; }
  if(a==="login"){ login(); return; }
  if(a==="logout"){ signOut(auth); return; }
  if(!canWrite) return;
  if(a==="m-new") matchForm(null);
  if(a==="m-edit") matchForm(S.matches.find(m => m.id===id));
  if(a==="p-new") playersNewForm();
  if(a==="p-edit") playerForm(P(id));
  if(a==="l-new") leagueForm(null);
  if(a==="l-edit") leagueForm(L(id));
  if(a==="club") clubForm();
  if(a==="dc-config") discordConfigForm();
  if(a==="bot-config") botConfigForm();
  if(a==="day-notice") dayNoticeForm();
  if(a==="dc-preview") discordPreview();
  if(a==="dc-sync") syncDiscord(false, true);
  if(a==="dc-new") syncDiscord(true, true);
  if(a==="dc-copy"){ const t=document.getElementById("dcpre").textContent; navigator.clipboard.writeText(t).then(() => toast("Texto copiado"), () => { const r=document.createRange(); r.selectNodeContents(document.getElementById("dcpre")); const s=getSelection(); s.removeAllRanges(); s.addRange(r); toast("Seleccioné el texto: copialo con Ctrl+C"); }); }
});
document.addEventListener("change", e => {
  const t = e.target; if(!t.classList) return;
  if(t.classList.contains("flt-l")){ ui.leagues = [...document.querySelectorAll(".flt-l:checked")].map(x => x.value); saveUi(); render(); }
  else if(t.classList.contains("flt-g")){ ui.groups = [...document.querySelectorAll(".flt-g:checked")].map(x => x.value); saveUi(); render(); }
  else if(t.name==="flt-mode"){ ui.statMode = t.value; saveUi(); render(); }
});
// Cerrar el filtro al tocar fuera de él.
document.addEventListener("pointerdown", e => { if(ui.fOpen && !e.target.closest(".fwrap") && !e.target.closest(".overlay")){ ui.fOpen = false; render(); } });
document.addEventListener("keydown", e => { if(e.key==="Escape" && modalHost.innerHTML && !busy) closeModal(); });
addEventListener("hashchange", () => { fromHash(); ui.open=null; ui.fOpen=false; render(); scrollTo(0,0); });

let toastT;
function toast(msg){ let t=document.querySelector(".toast"); if(!t){ t=document.createElement("div"); t.className="toast"; t.setAttribute("role","status"); document.body.appendChild(t); }
  t.textContent=msg; t.hidden=false; clearTimeout(toastT); toastT=setTimeout(() => { t.hidden=true; }, 4500); }

render();
