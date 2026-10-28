// Manda a Discord los partidos del día (fixture de Dark Empire).
// Lo ejecuta GitHub Actions todos los días (.github/workflows/fixture-diario.yml).
//
// Configuración (en GitHub → Settings → Secrets and variables → Actions):
//   Secret   DISCORD_WEBHOOK_URL  → la dirección del webhook del canal (obligatorio)
//   Variable DISCORD_MENCION      → a quién etiquetar (opcional):
//                                   "everyone", "here", o el ID de un rol (solo números)
import { readFileSync } from "node:fs";

const TZ = "America/Argentina/Buenos_Aires";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || "";
const MENCION = (process.env.DISCORD_MENCION || "").trim();
const MANUAL = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
const OWNER = process.env.GITHUB_REPOSITORY_OWNER || "";
const PAGE = OWNER ? `https://${OWNER.toLowerCase()}.github.io` : "";

// 1. Proyecto de Firebase: se toma de config.js (el mismo que usa la página).
const cfg = readFileSync(new URL("../config.js", import.meta.url), "utf8");
const projectId = (cfg.match(/projectId:\s*"([^"]+)"/) || [])[1];
if (!projectId) fail("config.js no tiene projectId. Completalo (paso 2 de la guía).");

// 2. Fecha de hoy en Argentina (o la que se pase a mano para probar).
const hoy = (process.env.FECHA || "").trim() || new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
if (!/^\d{4}-\d{2}-\d{2}$/.test(hoy)) fail(`Fecha inválida: "${hoy}". Usá el formato AAAA-MM-DD.`);

// 3. Leer los datos del club (lectura pública, igual que cualquier visitante).
const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/club/datos`;
const res = await fetch(url);
if (res.status === 404) fail("Todavía no hay datos cargados en la página.");
if (!res.ok) fail(`No se pudo leer Firebase (${res.status}): ${await res.text()}`);
const data = decodeFields((await res.json()).fields || {});
const leagues = data.leagues || [], matches = data.matches || [];
const clubName = (data.club && data.club.name) || "Dark Empire";

const delDia = matches
  .filter(m => m.date === hoy && m.status !== "jugado")
  .sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));

const fechaTxt = new Date(hoy + "T12:00:00-03:00").toLocaleDateString("es-AR", { timeZone: TZ, weekday: "long", day: "numeric", month: "numeric" });
console.log(`Fecha ${hoy}: ${delDia.length} partido(s).`);

if (!delDia.length && !MANUAL) { console.log("No hay partidos hoy: no se manda nada."); process.exit(0); }

// 4. Armar el mensaje.
const lines = delDia.map(m => {
  const l = leagues.find(x => x.id === m.league);
  const extra = [l && l.name, m.round].filter(Boolean).join(" · ");
  return `**${m.time || "Hora a confirmar"}** · vs **${clean(m.rival)}**${extra ? `\n${clean(extra)}` : ""}`;
});
const payload = {
  username: clubName,
  ...(PAGE ? { avatar_url: `${PAGE}/favicon.png` } : {}),
  content: mentionText() || undefined,
  allowed_mentions: allowedMentions(),
  embeds: [{
    title: delDia.length ? `Partidos de hoy · ${fechaTxt}` : `Prueba · ${fechaTxt}`,
    description: delDia.length ? lines.join("\n\n") : "No hay partidos cargados para este día. Si ves este mensaje, la conexión con Discord funciona.",
    color: 0x131315,
    ...(PAGE ? { url: PAGE, footer: { text: PAGE.replace("https://", "") } } : {}),
  }],
};
if (!delDia.length) { payload.content = undefined; payload.allowed_mentions = { parse: [] }; }

// 5. Enviar.
if (!WEBHOOK) { console.log("Sin DISCORD_WEBHOOK_URL: solo muestro el mensaje.\n" + JSON.stringify(payload, null, 2)); process.exit(0); }
const r = await fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
if (!r.ok) fail(`Discord rechazó el mensaje (${r.status}): ${await r.text()}`);
console.log("Mensaje enviado a Discord.");

// ---------- utilidades ----------
function mentionText() {
  if (!MENCION) return "";
  if (/^(@)?everyone$/i.test(MENCION)) return "@everyone";
  if (/^(@)?here$/i.test(MENCION)) return "@here";
  if (/^\d{5,25}$/.test(MENCION)) return `<@&${MENCION}>`;
  console.warn(`DISCORD_MENCION "${MENCION}" no es válida (usá everyone, here o el ID numérico de un rol). Se manda sin etiquetar.`);
  return "";
}
function allowedMentions() {
  if (/^(@)?(everyone|here)$/i.test(MENCION)) return { parse: ["everyone"] };
  if (/^\d{5,25}$/.test(MENCION)) return { parse: [], roles: [MENCION] };
  return { parse: [] };
}
function clean(s) { return String(s || "").replace(/[*_~`|>@]/g, c => "\\" + c).slice(0, 100); }
function decodeFields(f) { const o = {}; for (const k in f) o[k] = decode(f[k]); return o; }
function decode(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode);
  if ("timestampValue" in v) return v.timestampValue;
  return null;
}
function fail(msg) { console.error("ERROR: " + msg); process.exit(1); }
