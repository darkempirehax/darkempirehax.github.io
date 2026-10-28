// App del club: fixture, resultados, plantel, estadísticas y grabaciones.
// Datos en Firebase (Firestore). Lectura libre; escritura solo capitanes.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, deleteDoc, onSnapshot, runTransaction, Bytes } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

"use strict";
const COLORS = ["#3a6fd8","#5aa9f0","#22b8cf","#1f9a8a","#2fbf71","#5f7f2e","#a3c94a","#e8c23a","#c48a12","#d0712b","#d4513f","#b3263e","#e04f86","#c2508f","#7b5cd6","#a77ef0","#8d6e63","#9ea7b3","#f1f0ec"];
const POS = {ARQ:"Arquero",DEF:"Defensor",MED:"Medio",DEL:"Delantero"};
const TABS = [["partidos","Partidos"],["calendario","Calendario"],["estadisticas","Estadísticas"],["plantel","Plantel"],["ligas","Ligas"]];
const TZ = "America/Argentina/Buenos_Aires";
const todayStr = () => new Intl.DateTimeFormat("en-CA",{timeZone:TZ}).format(new Date());
const CAL_SLOTS = 5;
const MAX_REC = 900 * 1024;
const EMPTY = () => ({club:{name:"Dark Empire"}, leagues:[], players:[], matches:[]});

const app = document.getElementById("app");
const modalHost = document.createElement("div"); document.body.appendChild(modalHost);

let S = null;               // estado del club (null = cargando)
let loadError = null;
let canWrite = false, user = null, busy = false;
const ui = {tab:"partidos", league:"all", sort:"g", open:null, cal: todayStr().slice(0,7)};
try{ const sv = JSON.parse(localStorage.getItem("hx_ui") || "null"); if(sv){ ui.league = sv.league || "all"; ui.sort = sv.sort || "g"; } }catch(e){}
function saveUi(){ try{ localStorage.setItem("hx_ui", JSON.stringify({league:ui.league, sort:ui.sort})); }catch(e){} }
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
  });
}
function normalize(d){ d = d || {}; return {club: d.club || {name:"Dark Empire"}, leagues: d.leagues || [], players: d.players || [], matches: d.matches || []}; }

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
const inLeague = m => ui.league==="all" || m.league===ui.league;
function record(list){ const r={pj:0,g:0,e:0,p:0,df:0,gf:0,gc:0};
  list.forEach(m => { const x=res(m); if(!x) return; if(x==="DF"){ r.df++; return; } r.pj++; r[x==="G"?"g":x==="E"?"e":"p"]++; r.gf+=+m.gf||0; r.gc+=+m.gc||0; }); return r; }
const key = m => (m.date||"9999-99-99")+" "+(m.time||"99:99");
const upcoming = list => list.filter(m => m.status!=="jugado").sort((a,b) => key(a)<key(b)?-1:1);
const played = list => list.filter(m => m.status==="jugado").sort((a,b) => key(a)<key(b)?1:-1);
function stats(list){
  const t={}; S.players.forEach(p => { t[p.id]={id:p.id,pj:0,g:0,a:0,mvp:0}; });
  list.forEach(m => { if(m.status!=="jugado" || m.df) return;
    (m.lineup||[]).forEach(r => { const s=t[r.p]; if(!s) return; s.pj++; s.g+=+r.g||0; s.a+=+r.a||0; });
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
function leagueChips(){
  if(!S.leagues.length) return "";
  return '<div class="chips" role="group" aria-label="Filtrar por liga">'
    + '<button class="chip" data-act="lg" data-id="all" aria-pressed="'+(ui.league==="all")+'">Todas</button>'
    + S.leagues.map(l => '<button class="chip" data-act="lg" data-id="'+esc(l.id)+'" aria-pressed="'+(ui.league===l.id)+'"><span class="dot" style="--lg:'+esc(l.color)+'"></span>'+esc(l.name)+'</button>').join("")
    + '</div>';
}
function startGuide(){
  return '<div class="empty"><b>Todavía no hay nada cargado.</b>'+(canWrite ?
    '<ol><li>En <a href="#ligas">Ligas</a>, creá las ligas que juegan.</li><li>En <a href="#plantel">Plantel</a>, agregá a los jugadores.</li><li>Acá en Partidos, cargá el fixture y después los resultados.</li></ol>'
    : '<br>Cuando los capitanes carguen el fixture, lo vas a ver acá.')+'</div>';
}
function vMatches(){
  const list = S.matches.filter(inLeague), up = upcoming(list), pl = played(list);
  let h = '<div class="bar">'+leagueChips()+(canWrite ? '<button class="btn" data-act="m-new"'+(S.leagues.length?'':' disabled title="Primero creá una liga"')+'>+ Partido</button>' : '')+'</div>';
  if(ui.league!=="all" && tablaBtn(L(ui.league))) h += '<div class="acts">'+tablaBtn(L(ui.league))+'</div>';
  if(!S.matches.length) return h + startGuide();
  h += '<section class="sec"><h2>Próximos <small>'+up.length+'</small></h2>'+(up.length ? '<div class="list">'+up.map(matchRow).join("")+'</div>' : '<div class="empty">No hay partidos pendientes'+(ui.league!=="all"?" en esta liga":"")+'.</div>')+'</section>';
  h += '<section class="sec"><h2>Resultados <small>'+pl.length+'</small></h2>'+(pl.length ? '<div class="list">'+pl.map(matchRow).join("")+'</div>' : '<div class="empty">Todavía no hay resultados cargados.</div>')+'</section>';
  return h;
}
function matchRow(m){
  const r = res(m), open = ui.open===m.id, clickable = canWrite || r || m.rec || m.notes;
  let h = '<article class="match"><button class="mrow" data-act="m-open" data-id="'+esc(m.id)+'" aria-expanded="'+open+'"'+(clickable?'':' disabled')+'>'
    + '<div class="mdate"><b>'+esc(fmtDate(m.date))+'</b><span>'+esc(m.time||"Sin hora")+'</span></div>'
    + '<div style="min-width:0"><div class="mmeta">'+lgBadge(m.league)+(m.round?' · '+esc(m.round):'')+(m.rec?' <span class="rectag" title="Tiene grabación">REC</span>':'')+'</div><div class="mrival">vs '+esc(m.rival)+'</div></div>'
    + scoreBadge(m)
    + '</button>';
  if(open) h += '<div class="mdetail">'+matchInfo(m)+'</div>';
  return h + '</article>';
}
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
    if(canWrite) h += '<div class="acts"><button class="btn small ghost" data-act="m-edit" data-id="'+esc(m.id)+'">'+(r?'Editar resultado':'Cargar resultado / editar')+'</button></div>';
  if(!h) h = '<div class="hint">'+(r ? 'Sin detalles cargados.' : 'Partido programado.')+'</div>';
  return h;
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
  const t = stats(S.matches.filter(inLeague));
  const rows = S.players.map(p => t[p.id]).filter(s => P(s.id).active!==false || s.pj>0);
  const k = ui.sort, val = (s) => k==="ga" ? s.g+s.a : s[k];
  rows.sort((a,b) => k==="name" ? P(a.id).name.localeCompare(P(b.id).name)
    : (val(b)-val(a) || (b.g+b.a)-(a.g+a.a) || P(a.id).name.localeCompare(P(b.id).name)));
  let h = '<div class="bar">'+leagueChips()+'</div>';
  if(!S.players.length) return h + '<div class="empty">'+(canWrite?'Agregá jugadores en <a href="#plantel">Plantel</a> y cargá resultados para ver las estadísticas.':'Todavía no hay jugadores cargados.')+'</div>';
  function top(f,label){ let best=0; rows.forEach(s => { best=Math.max(best,f(s)); });
    const ties = best ? rows.filter(s => f(s)===best).map(s => P(s.id).name) : [];
    return '<div class="leader"><span>'+label+'</span>'+(best ? '<i class="num">'+best+'</i><b>'+esc(ties.join(", "))+'</b>' : '<b>—</b>')+'</div>'; }
  h += '<div class="leaders">'+top(s=>s.g,"Goleador")+top(s=>s.a,"Asistidor")+top(s=>s.mvp,"Más veces figura")+'</div>';
  const cols=[["name","Jugador"],["pj","PJ"],["g","Goles"],["a","Asist."],["ga","G+A"],["mvp","Figura"]];
  h += '<div class="tablewrap"><table><thead><tr>'+cols.map(c => '<th scope="col"><button data-act="sort" data-id="'+c[0]+'" aria-pressed="'+(k===c[0])+'">'+c[1]+(k===c[0]&&c[0]!=="name"?" ▾":"")+'</button></th>').join("")+'<th scope="col">Prom. gol</th></tr></thead><tbody>'
    + rows.map(s => { const p=P(s.id), hl = c => k===c?' class="hl"':'';
      return '<tr'+(p.active===false?' class="off"':'')+'><td><button class="pname" data-act="p-view" data-id="'+esc(p.id)+'">'+esc(p.name)+'</button>'+posList(p).map(k => '<span class="pos">'+esc(k)+'</span>').join("")+'</td><td>'+s.pj+'</td><td'+hl("g")+'>'+s.g+'</td><td'+hl("a")+'>'+s.a+'</td><td'+hl("ga")+'>'+(s.g+s.a)+'</td><td'+hl("mvp")+'>'+s.mvp+'</td><td>'+(s.pj?(s.g/s.pj).toFixed(2):"—")+'</td></tr>'; }).join("")
    + '</tbody></table></div>';
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
  if(!S.leagues.length) return h + '<div class="empty">'+(canWrite?'Creá la primera liga para empezar a cargar el fixture.':'Todavía no hay ligas cargadas.')+'</div>';
  h += '<div class="grid">'+S.leagues.map(l => {
    const ms = S.matches.filter(m => m.league===l.id), r = record(ms), pend = ms.filter(m => m.status!=="jugado").length;
    const inner = '<h3><span class="dot" style="--lg:'+esc(l.color)+';width:12px;height:12px"></span>'+esc(l.name)+'</h3>'
      + '<div class="sub">'+(l.note?esc(l.note)+' · ':'')+pend+' pendiente'+(pend===1?'':'s')+'</div>'
      + '<div class="minis num"><span><b>'+r.pj+'</b> PJ</span><span><b>'+r.g+'-'+r.e+'-'+r.p+'</b> G-E-P</span>'+(r.df?'<span><b>'+r.df+'</b> DF</span>':'')+'</div>';
    const acts = tablaBtn(l) + (canWrite ? '<button class="btn ghost small" data-act="l-edit" data-id="'+esc(l.id)+'">Editar</button>' : '');
    return '<div class="card">'+inner+(acts?'<div class="acts">'+acts+'</div>':'')+'</div>';
  }).join("")+'</div>';
  return h;
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
  m = m || {id:uid(), league: ui.league!=="all" ? ui.league : (S.leagues[0]||{}).id, status:"pendiente", lineup:[]};
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
    + '<div class="seg" role="radiogroup" aria-label="Estado"><label><input type="radio" name="st" id="st-p" value="pendiente"'+(m.status!=="jugado"?' checked':'')+'>Pendiente</label><label><input type="radio" name="st" id="st-j" value="jugado"'+(m.status==="jugado"?' checked':'')+'>Jugado</label></div>'
    + '<div id="resblock"'+(m.status==="jugado"?'':' hidden')+' style="display:grid;gap:12px">'
    + '<label class="dftoggle"><input type="checkbox" id="f-df"'+(m.df?' checked':'')+'><span><b>DF</b> · El rival no se presentó (3–0)</span></label>'
    + '<div class="scorein"><label class="f" style="text-align:center"><span>Nosotros</span><input type="number" min="0" max="99" id="f-gf" value="'+(m.gf!=null?+m.gf:"")+'"></label><b style="font:700 28px var(--f-display)">–</b><label class="f" style="text-align:center"><span>Rival</span><input type="number" min="0" max="99" id="f-gc" value="'+(m.gc!=null?+m.gc:"")+'"></label></div>'
    + '<div id="lineupblock" style="display:grid;gap:12px">'+(roster.length ? '<div class="tablewrap"><table class="lineup"><thead><tr><th>Jugador</th><th>Jugó</th><th>Goles</th><th>Asist.</th><th>Figura</th></tr></thead><tbody>'
      + roster.map(p => { const r=lu[p.id], id=esc(p.id), n=esc(p.name); return '<tr data-p="'+id+'"><td>'+n+'</td><td><input type="checkbox" id="pl-'+id+'" aria-label="Jugó '+n+'"'+(r?' checked':'')+'></td>'
        + '<td><input type="number" min="0" max="99" id="g-'+id+'" aria-label="Goles de '+n+'" value="'+(r&&+r.g?+r.g:"")+'" placeholder="0"></td>'
        + '<td><input type="number" min="0" max="99" id="a-'+id+'" aria-label="Asistencias de '+n+'" value="'+(r&&+r.a?+r.a:"")+'" placeholder="0"></td>'
        + '<td><input type="radio" name="mvp" id="mvp-'+id+'" value="'+id+'" aria-label="Figura: '+n+'"'+(m.mvp===p.id?' checked':'')+'></td></tr>'; }).join("")
      + '</tbody></table></div><div class="hint" id="tally"></div>' : '<div class="hint">Agregá jugadores en Plantel para cargarles goles y asistencias.</div>')+'</div>'
    + '</div>'
    + '<div class="filein"><span>Grabación del partido (.hbr2)</span>'
    + (m.rec ? '<div class="recbox" id="recnow"><span style="color:var(--ink);font-weight:500">'+esc(m.rec.name)+' · '+kb(m.rec.size||0)+'</span><button type="button" class="btn ghost small" data-act="rec-rm">Quitar</button></div>' : '')
    + '<input type="file" id="f-rec" accept=".hbr2,.hbr,.hbrp"><span class="hint" id="rechint">'+(m.rec?'Elegí otro archivo para reemplazarla.':'Opcional. Hasta 900 KB.')+'</span></div>'
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
      else if(f){ hint.textContent="Se va a subir "+f.name+" ("+kb(f.size)+") al guardar."; hint.className="hint"; } }
    tally(); });
  form.addEventListener("input", e => { const t=e.target;
    if(t.id && /^(g|a)-/.test(t.id) && +t.value>0){ const cb=$("pl-"+t.id.slice(2)); if(cb) cb.checked=true; }
    if(t.name==="mvp"){ const c2=$("pl-"+t.value); if(c2) c2.checked=true; }
    tally(); });
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
        if($("pl-"+id).checked || g || a) nm.lineup.push({p:id,g,a}); });
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
    const ok = await commit(n => { const i=n.matches.findIndex(x => x.id===nm.id); if(i<0) n.matches.push(nm); else n.matches[i]=nm; },
      isNew ? "Partido agregado al fixture" : (nm.df ? "Guardado como DF (3–0)" : st==="jugado" ? "Resultado guardado" : "Partido actualizado"));
    if(ok && oldRec && (!nm.rec || nm.rec.id!==oldRec.id)) deleteDoc(doc(db,"grabaciones",oldRec.id)).catch(()=>{});
    if(!ok && file && nm.rec) deleteDoc(doc(db,"grabaciones",nm.rec.id)).catch(()=>{});
  });
}
function playerView(p){
  const ms = played(S.matches).filter(m => !m.df && (m.lineup||[]).some(r => r.p===p.id));
  let g=0,a=0,f=0;
  const rows = ms.map(m => { const r=(m.lineup||[]).find(x => x.p===p.id), x=res(m); g+=+r.g||0; a+=+r.a||0; if(m.mvp===p.id) f++;
    const bits = [];
    if(+r.g) bits.push('<b>'+(+r.g)+'</b> '+(+r.g===1?'gol':'goles'));
    if(+r.a) bits.push('<b>'+(+r.a)+'</b> '+(+r.a===1?'asist.':'asist.'));
    if(m.mvp===p.id) bits.push('<span class="mvptag">Figura</span>');
    return '<li class="pm'+(bits.length?' hit':'')+'"><div class="mdate"><b>'+esc(fmtDate(m.date))+'</b></div>'
      + '<div style="min-width:0"><div class="mmeta">'+lgBadge(m.league)+(m.round?' · '+esc(m.round):'')+'</div><div class="mrival">vs '+esc(m.rival)+'</div>'
      + '<div class="contrib">'+(bits.join(' · ')||'<span class="hint">Sin goles ni asistencias</span>')+'</div></div>'
      + '<div class="score small num '+x+'">'+(+m.gf)+'–'+(+m.gc)+'</div></li>'; }).join("");
  const pos = posList(p).map(k => POS[k]).join(" · ");
  openModal('<div class="pview"><h2 style="display:flex;align-items:center;gap:10px"><span class="shirt num">'+esc(p.num||"·")+'</span>'+esc(p.name)+'</h2>'
    + '<div class="hint">'+esc(pos||"Sin posición")+(p.active===false?' · De baja':'')+'</div>'
    + '<div class="record num">'+rec(ms.length,"PJ")+rec(g,"Goles")+rec(a,"Asist.")+rec(f,"Figura")+'</div>'
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
    + '<div class="filein"><span>Posiciones (podés marcar varias)</span><div class="chips poschk" role="group" aria-label="Posiciones">'+Object.keys(POS).map(k => '<label class="chip"><input type="checkbox" name="pos" id="pos-'+k+'" value="'+k+'"'+(posList(p).includes(k)?' checked':'')+'>'+POS[k]+'</label>').join("")+'</div></div>'
    + '<div class="seg" role="radiogroup" aria-label="Estado"><label><input type="radio" name="ac" id="ac-1" value="1"'+(p.active!==false?' checked':'')+'>En el plantel</label><label><input type="radio" name="ac" id="ac-0" value="0"'+(p.active===false?' checked':'')+'>De baja</label></div>'
    + (hasStats ? '<div class="hint">Tiene estadísticas cargadas: si se va del club, dalo de baja en vez de borrarlo así no se pierden.</div>' : '')
    + foot(hasStats ? "Borrarlo también saca sus goles y asistencias de las estadísticas. ¿Seguro?" : "¿Borrar a este jugador?")+'</form>');
  const form=document.getElementById("pe");
  onDelete = () => commit(n => { n.players=n.players.filter(x => x.id!==p.id);
    n.matches.forEach(m => { if(m.lineup) m.lineup=m.lineup.filter(r => r.p!==p.id); if(m.mvp===p.id) m.mvp=null; }); }, "Jugador borrado");
  form.addEventListener("submit", e => { e.preventDefault(); const nm=document.getElementById("f-pname").value.trim(); if(!nm) return;
    const upd={name:nm, pos:[...form.querySelectorAll('input[name="pos"]:checked')].map(x => x.value), num:document.getElementById("f-num").value.trim(), active: form.querySelector('input[name="ac"]:checked').value==="1"};
    commit(n => { const x = n.players.find(x => x.id===p.id); if(x) Object.assign(x, upd); }, "Jugador actualizado"); });
}
function leagueForm(l){
  const isNew=!l; l = l || {id:uid(), name:"", note:"", color: COLORS[S.leagues.length % COLORS.length]};
  const used = S.matches.filter(m => m.league===l.id).length;
  openModal('<form id="lf"><h2>'+(isNew?'Nueva liga':esc(l.name))+'</h2><div class="fields">'
    + '<label class="f">Nombre<input type="text" id="f-lname" required maxlength="40" value="'+esc(l.name)+'" placeholder="Liga Argentina de Haxball"></label>'
    + '<label class="f">Detalle<input type="text" id="f-lnote" maxlength="60" value="'+esc(l.note||"")+'" placeholder="División, torneo, temporada…"></label></div>'
    + '<label class="f">Link de la tabla de posiciones<input type="text" id="f-llink" autocomplete="off" maxlength="300" inputmode="url" value="'+esc(l.link||"")+'" placeholder="https://challenge.place/c/..."><span class="hint" id="llhint">Opcional. Pegá el link de la liga en challenge.place (o donde publiquen la tabla).</span></label>'
    + '<div class="filein"><span>Color</span><div class="swatches" role="radiogroup" aria-label="Color">'+COLORS.map((c,i) => '<label class="swatch" style="--sw:'+c+'" title="'+c+'"><input type="radio" name="lc" id="lc-'+i+'" value="'+c+'"'+(c===l.color?' checked':'')+' aria-label="Color '+(i+1)+'"></label>').join("")
    + '<label class="swatch custom" title="Elegir otro color"><input type="radio" name="lc" id="lc-x" value="custom"'+(COLORS.includes(l.color)?'':' checked')+' aria-label="Otro color"><input type="color" id="f-lcolor" value="'+(COLORS.includes(l.color)||!/^#[0-9a-f]{6}$/i.test(l.color||"")?'#888888':esc(l.color))+'" aria-label="Elegir otro color"><span>Otro</span></label></div></div>'
    + (used ? '<div class="hint">Tiene '+used+' partido'+(used===1?'':'s')+'. Para borrarla, primero borrá esos partidos o pasalos a otra liga.</div>' : '')
    + foot(isNew||used ? "" : "¿Borrar esta liga?")+'</form>');
  const form=document.getElementById("lf");
  document.getElementById("f-lcolor").addEventListener("input", () => { document.getElementById("lc-x").checked = true; });
  onDelete = () => commit(n => { n.leagues=n.leagues.filter(x => x.id!==l.id); }, "Liga borrada");
  form.addEventListener("submit", e => { e.preventDefault(); const nm=document.getElementById("f-lname").value.trim(); if(!nm) return;
    const c=form.querySelector('input[name="lc"]:checked'); const pick = c && c.value==="custom" ? document.getElementById("f-lcolor").value : (c ? c.value : l.color); const color = /^#[0-9a-f]{6}$/i.test(pick) ? pick : l.color; let rawLink=document.getElementById("f-llink").value.trim(); if(rawLink && !/^[a-z]+:/i.test(rawLink)) rawLink="https://"+rawLink; const link=rawLink?safeUrl(rawLink):"";
    if(rawLink && !link){ const hh=document.getElementById("llhint"); hh.textContent="Ese link no es válido: tiene que empezar con https://"; hh.className="hint warn"; document.getElementById("f-llink").focus(); return; }
    const nl={id:l.id,name:nm,note:document.getElementById("f-lnote").value.trim(),color,link};
    commit(n => { const i=n.leagues.findIndex(x => x.id===nl.id); if(i<0) n.leagues.push(nl); else n.leagues[i]=nl; }, isNew?"Liga creada":"Liga actualizada"); });
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
    busy = false; closeModal(); toast(msg); return true;
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
  if(a==="lg"){ ui.league=id; saveUi(); render(); return; }
  if(a==="sort"){ ui.sort=id; saveUi(); render(); return; }
  if(a==="cal"){ if(id==="0") ui.cal = todayStr().slice(0,7); else { const [yy,mm]=ui.cal.split("-").map(Number); const dt=new Date(Date.UTC(yy,mm-1+Number(id),1)); ui.cal = dt.getUTCFullYear()+"-"+String(dt.getUTCMonth()+1).padStart(2,"0"); } render(); return; }
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
});
document.addEventListener("keydown", e => { if(e.key==="Escape" && modalHost.innerHTML && !busy) closeModal(); });
addEventListener("hashchange", () => { fromHash(); ui.open=null; render(); scrollTo(0,0); });

let toastT;
function toast(msg){ let t=document.querySelector(".toast"); if(!t){ t=document.createElement("div"); t.className="toast"; t.setAttribute("role","status"); document.body.appendChild(t); }
  t.textContent=msg; t.hidden=false; clearTimeout(toastT); toastT=setTimeout(() => { t.hidden=true; }, 4500); }

render();
