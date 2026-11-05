// Analizador de grabaciones de Haxball (.hbr2).
// Usa la librería libre node-haxball (MIT, https://github.com/wxyz-abcd/node-haxball),
// que reproduce el partido dentro del navegador. Mientras se reproduce, registramos
// quién PATEA la pelota. En cada gol: el último en patear es el goleador, y el pateador
// anterior (otro jugador) da la asistencia si es del mismo equipo. Si el último en patear
// es del equipo que recibe el gol, es gol en contra. (Mismo criterio que Haxanalyzer.)
// Los pases cuentan también los controles con el cuerpo (ver passTouch).
// Cada vez que se reinicia el juego (por ejemplo, entre el 1º y el 2º tiempo) empieza un tramo nuevo.

const LIBS = [
  "https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js",
  "https://cdn.jsdelivr.net/npm/json5@2.2.3/dist/index.min.js",
  "https://cdn.jsdelivr.net/npm/node-haxball@2.3.1/src/api.js",
];
let apiPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.async = false;
    s.onload = resolve;
    s.onerror = () => reject(new Error("No se pudo descargar el analizador. Revisá tu conexión y probá de nuevo."));
    document.head.appendChild(s);
  });
}
export function loadHaxball() {
  if (!apiPromise) apiPromise = (async () => {
    for (const u of LIBS) await loadScript(u);
    if (!window.abcHaxballAPI) throw new Error("No se pudo iniciar el analizador.");
    return window.abcHaxballAPI(window);
  })().catch(e => { apiPromise = null; throw e; });
  return apiPromise;
}

/**
 * Analiza una grabación. Devuelve una lista de partidos (una grabación puede tener varios
 * si se reinició el juego), cada uno con:
 *   red, blue: goles de cada equipo
 *   goals: [{team, scorer, assist, own, time}]  (scorer/assist/own = {id, name, team} o null)
 *   players: {id: {id, name, ticks: {1: n, 2: n}}}  (tiempo en cancha por equipo)
 *   passes: {nick: {done, tried}}  (pases acertados e intentados; los intentos solo se usan para el %)
 *   starters: {1: [nicks], 2: [nicks]}  titulares;  deep: {nick: {1: n, 2: n}}  ticks como el más retrasado (arquero)
 *   dur: duración en segundos;  players[id].first[team]: tick en que apareció en ese equipo
 *   ticks: duración en ticks (60 por segundo)
 */
export async function analyzeReplay(bytes, { onProgress } = {}) {
  const API = await loadHaxball();
  return new Promise((resolve, reject) => {
    let reader, g = null, touches = [], tick = 0, done = false;
    let lastKick = null; // para pases: última patada pendiente {name, team, game, tick}
    const games = [];
    const newGame = () => { g = { goals: [], players: {}, passes: {}, ticks: 0, red: 0, blue: 0, dur: 0, starters: null, side: null, deep: {} }; games.push(g); touches = []; };
    const info = id => { const p = reader.state.getPlayer(id); return p ? { id, name: p.name, team: (p.team && p.team.id) || 0 } : null; };
    function touch(id) {
      const p = info(id); if (!p || !p.team) return;
      const last = touches[touches.length - 1];
      if (last && last.id === id && last.team === p.team) { last.tick = tick; return; }
      touches.push({ ...p, tick });
      if (touches.length > 10) touches.shift();
    }
    // Pases: después de una patada, el siguiente jugador que toca la pelota (pateando o con el cuerpo)
    // decide el pase. Compañero = pase acertado; rival = pase errado. Si la vuelve a tocar el mismo
    // jugador, no cuenta como intento. Un tiro que termina en gol tampoco.
    function passTouch(p, isKick) {
      if (!lastKick) return;
      if (p.name === lastKick.name) {
        if (!isKick && tick - lastKick.tick > 4) lastKick = null; // se la quedó él mismo
        return;
      }
      const s = lastKick.game.passes[lastKick.name] || (lastKick.game.passes[lastKick.name] = { done: 0, tried: 0 });
      s.tried++; if (p.team === lastKick.team) s.done++;
      lastKick = null;
    }
    function finish() {
      if (done) return; done = true;
      try { reader.destroy(); } catch (e) {}
      resolve(games.filter(x => x.ticks > 0 || x.goals.length));
    }
    try {
      reader = API.Replay.read(bytes, {
        onGameStart: () => newGame(),
        onPositionsReset: () => { touches = []; lastKick = null; },
        onCollisionDiscVsDisc: (d1, p1, d2, p2) => {
          const pid = d1 === 0 ? p2 : d2 === 0 ? p1 : null; // disco 0 = pelota
          if (pid == null || !g) return;
          const p = info(pid); if (p && p.team) passTouch(p, false);
        },
        onPlayerBallKick: id => {
          if (!g) newGame();
          const p = info(id);
          if (p && p.team) { passTouch(p, true); lastKick = { name: p.name, team: p.team, game: g, tick }; }
          touch(id);
        },
        onGameTick: () => {
          tick++;
          const gs = reader.gameState; if (!gs) return;
          if (!g) newGame();
          if (gs.state !== 0 && gs.state !== 1) return; // 0 = saque, 1 = en juego
          g.ticks++; g.dur = gs.timeElapsed || g.dur;
          const deepest = { 1: null, 2: null };
          for (const p of reader.state.players) {
            const t = p.team && p.team.id; if (!t) continue;
            const s = g.players[p.id] || (g.players[p.id] = { id: p.id, name: p.name, ticks: { 1: 0, 2: 0 }, first: { 1: null, 2: null } });
            s.name = p.name; s.ticks[t]++;
            if (s.first[t] == null) s.first[t] = g.ticks;
            // Arquero: el jugador más cerca de su propio arco la mayor parte del tiempo.
            if (g.side && gs.state === 1 && p.disc) { const v = p.disc.pos.x * g.side[t]; if (!deepest[t] || v > deepest[t].v) deepest[t] = { v, name: p.name }; }
          }
          for (const t of [1, 2]) if (deepest[t]) { const d = g.deep[deepest[t].name] || (g.deep[deepest[t].name] = { 1: 0, 2: 0 }); d[t]++; }
          // Titulares: quiénes estaban en cada equipo al empezar; y de qué lado defiende cada uno.
          if (!g.starters) {
            const st = { 1: [], 2: [] }, xs = { 1: [], 2: [] };
            for (const p of reader.state.players) { const t = p.team && p.team.id; if (!t) continue; st[t].push(p.name); if (p.disc) xs[t].push(p.disc.pos.x); }
            if (st[1].length && st[2].length) {
              g.starters = st;
              const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
              const left1 = xs[1].length && xs[2].length ? avg(xs[1]) <= avg(xs[2]) : true; // el rojo suele defender a la izquierda
              g.side = { 1: left1 ? -1 : 1, 2: left1 ? 1 : -1 };
            }
          }
          if (onProgress && tick % 900 === 0 && reader.maxFrameNo) onProgress(Math.min(0.99, reader.getCurrentFrameNo() / reader.maxFrameNo));
        },
        onTeamGoal: teamId => {
          if (!g) newGame();
          const gs = reader.gameState;
          const last = touches[touches.length - 1];
          let scorer = null, assist = null, own = null;
          if (last) {
            if (last.team === teamId) {
              scorer = last;
              const prev = touches[touches.length - 2];   // pateador anterior (distinto: los repetidos se unifican)
              if (prev && prev.team === teamId) assist = prev;
            } else own = last;
          }
          g.goals.push({ team: teamId, scorer, assist, own, time: gs ? gs.timeElapsed : 0 });
          lastKick = null;
          if (gs) { g.red = gs.redScore; g.blue = gs.blueScore; }
          touches = [];
        },
        onGameEnd: () => { const gs = reader.gameState; if (g && gs) { g.red = gs.redScore; g.blue = gs.blueScore; } },
      }, { requestAnimationFrame: f => setTimeout(f, 0), cancelAnimationFrame: clearTimeout });
    } catch (e) {
      reject(new Error("Ese archivo no es una grabación de Haxball válida (.hbr2)."));
      return;
    }
    reader.onEnd = finish;
    reader.setSpeed(20000);
    // Red de seguridad: si por algún motivo no llega el final, cortamos a los 3 minutos.
    setTimeout(() => { if (!done) { done = true; try { reader.destroy(); } catch (e) {} reject(new Error("La grabación tardó demasiado en analizarse.")); } }, 180000);
  });
}

/* ---------- Reconocimiento de nicks ---------- */

// Nick "limpio": minúsculas, sin tildes, sin tags de clan entre corchetes y sin símbolos.
export function normNick(s) {
  const base = String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const sinTags = base.replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|<[^>]*>/g, " ");
  const limpiar = x => x.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  return limpiar(sinTags) || limpiar(base);
}
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j), cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
function similarity(nick, key) {
  const n = normNick(nick), k = normNick(key);
  if (!n || !k) return 0;
  const nc = n.replace(/ /g, ""), kc = k.replace(/ /g, "");
  if (nc === kc) return 1;
  let s = 0;
  if (nc.length >= 3 && kc.startsWith(nc)) s = Math.max(s, 0.9);          // "pet" → "petr cech"
  if (kc.length >= 3 && nc.startsWith(kc)) s = Math.max(s, 0.88);         // "petrcech10" → "petr cech"
  if (nc.length >= 3 && kc.includes(nc)) s = Math.max(s, 0.84);
  if (kc.length >= 3 && nc.includes(kc)) s = Math.max(s, 0.84);
  const nw = n.split(" "), kw = k.split(" ");
  if (nw.some(w => w.length >= 3 && kw.includes(w))) s = Math.max(s, 0.86); // misma palabra: "cech" → "petr cech"
  const L = Math.max(nc.length, kc.length);
  s = Math.max(s, (1 - lev(nc, kc) / L) * 0.95);                           // errores de tipeo
  return s;
}

/**
 * Busca a qué jugador del club corresponde un nick.
 * players: [{id, name, aliases}]
 * Devuelve {id, score, kind: "memoria" | "parecido", ambiguous} o null si no encuentra.
 */
export function matchNick(nick, players) {
  const n = normNick(nick);
  // 1) Nick ya guardado en la memoria de un jugador (o igual a su nombre).
  for (const p of players) {
    if (normNick(p.name) === n || (p.aliases || []).some(a => normNick(a) === n)) return { id: p.id, score: 1, kind: "memoria", ambiguous: false };
  }
  // 2) Parecido.
  let best = null, second = 0;
  for (const p of players) {
    const sc = Math.max(...[p.name, ...(p.aliases || [])].map(k => similarity(nick, k)));
    if (!best || sc > best.score) { second = best ? best.score : second; best = { id: p.id, score: sc }; }
    else if (sc > second) second = sc;
  }
  if (!best || best.score < 0.72) return null;
  return { id: best.id, score: best.score, kind: "parecido", ambiguous: best.score - second < 0.05 };
}
