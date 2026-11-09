// Arma el texto del mensaje "CALENDARIO DE PARTIDOS OFICIALES" para Discord.
// Lo usan la página (al guardar cambios) y la tarea diaria de GitHub, así los dos
// generan exactamente el mismo mensaje. Muestra desde hoy hasta el último día con partido.

const DIAS = ["LUNES", "MARTES", "MIERCOLES", "JUEVES", "VIERNES", "SABADO", "DOMINGO"];
const DAY = 86400000;

// Días desde `desde` hasta `hasta` inclusive (AAAA-MM-DD, fechas de Argentina).
export function dias(desde, hasta) {
  const ms = x => { const [y, m, d] = x.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  const out = [], fin = Math.max(ms(desde), ms(hasta));
  for (let t = ms(desde); t <= fin && out.length < 120; t += DAY) {
    const x = new Date(t);
    out.push({ nombre: DIAS[(x.getUTCDay() + 6) % 7], iso: x.toISOString().slice(0, 10), corto: x.getUTCDate() + "/" + (x.getUTCMonth() + 1) });
  }
  return out;
}

function hora(t) {
  if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return "HORA A CONF.";
  const [h, mi] = t.split(":");
  return (mi === "00" ? String(+h) : String(+h) + ":" + mi) + "HS";
}
function limpio(s) { return String(s || "").replace(/[`*_~|\\@<>]/g, "").replace(/\s+/g, " ").trim().toUpperCase(); }

export function renderCalendario(data, hoy) {
  const leagues = (data && data.leagues) || [], matches = (data && data.matches) || [];
  const liga = id => { const l = leagues.find(x => x.id === id); return l ? limpio(l.short || l.name) : "SIN LIGA"; };
  const vs = m => `${liga(m.league)} VS ${limpio(m.rival)}`;
  const porJugar = matches.filter(m => m.status !== "jugado");
  const out = ["**`CALENDARIO DE PARTIDOS OFICIALES:`**", ""];
  // Desde hoy hasta el último día con un partido programado.
  const ultimo = porJugar.map(m => m.date || "").filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= hoy).sort().pop() || hoy;
  for (const dia of dias(hoy, ultimo)) {
    const ms = porJugar.filter(m => m.date === dia.iso).sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));
    out.push("`" + dia.nombre + " " + dia.corto + "`");
    out.push(ms.length ? ms.map(m => hora(m.time) + " " + vs(m)).join("\n") : "-");
    out.push("");
  }
  const pend = porJugar.filter(m => !m.date).sort((a, b) => vs(a).localeCompare(vs(b)));
  out.push("`PENDIENTES:`");
  out.push(pend.length ? pend.map(vs).join("\n") : "-");
  let txt = out.join("\n");
  if (txt.length > 1990) txt = txt.slice(0, 1985) + "\n…";
  return txt;
}

// Valida la dirección de un webhook de Discord.
export function webhookValido(u) {
  return /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(String(u || "").trim());
}

// Avisos de los partidos del día: un mensaje por partido, con el rol de Discord de la liga.
// Devuelve [{content, roles, preview}] (preview = texto legible, con el nombre de la liga en vez del rol).
export function avisosDelDia(data, hoy) {
  const leagues = (data && data.leagues) || [], matches = (data && data.matches) || [];
  return matches
    .filter(m => m.date === hoy && m.status !== "jugado")
    .sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"))
    .map(m => {
      const l = leagues.find(x => x.id === m.league);
      const role = l && /^\d{15,25}$/.test(String(l.role || "")) ? String(l.role) : "";
      const nombre = l ? limpio(l.short || l.name) : "SIN LIGA";
      const base = hora(m.time) + " ";
      const ronda = String(m.round || "").replace(/[`*_~|\\@<>]/g, "").replace(/\s+/g, " ").trim();
      const fin = " VS " + limpio(m.rival) + (ronda ? " - " + ronda : "");   // ej.: VS BOCA - Fecha 3
      return {
        content: base + (role ? "<@&" + role + ">" : nombre) + fin,
        preview: base + (role ? "@" + (l.name || nombre) : nombre) + fin,
        roles: role ? [role] : [],
      };
    });
}

// Reacciones: emojis separados por espacio o coma; los del servidor como <:nombre:id>.
export function parseEmojis(txt) {
  return String(txt || "").split(/[\s,]+/).filter(Boolean).map(e => { const c = e.match(/^<a?:(\w+):(\d+)>$/); return c ? c[1] + ":" + c[2] : e; }).slice(0, 10);
}
