// Manda a Discord un mensaje por cada partido programado para hoy, etiquetando el rol de la liga,
// y le pone las reacciones configuradas. Lo dispara el botón "Avisar partidos de hoy" de la página
// (o "Run workflow" en GitHub → Actions → Avisos del día en Discord).
//
// Configuración:
//   Secret DISCORD_BOT_TOKEN → el token del bot (GitHub → Settings → Secrets and variables → Actions)
//   El canal y las reacciones se eligen en la página (Ligas → Discord → Configurar avisos).
import { readFileSync } from "node:fs";
import { avisosDelDia, parseEmojis } from "./calendario-render.js";

const TZ = "America/Argentina/Buenos_Aires";
const TOKEN = (process.env.DISCORD_BOT_TOKEN || "").trim();
const API = "https://discord.com/api/v10";

const cfg = readFileSync(new URL("../config.js", import.meta.url), "utf8");
const projectId = (cfg.match(/projectId:\s*"([^"]+)"/) || [])[1];
if (!projectId) fail("config.js no tiene projectId.");
if (!TOKEN) fail("Falta el secret DISCORD_BOT_TOKEN en GitHub (Settings → Secrets and variables → Actions).");

const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/club`;
const datos = await leer(`${base}/datos`);
const disc = (await leer(`${base}/discord`)) || {};
if (!datos) fail("Todavía no hay datos cargados en la página.");
const canal = String(disc.dayChannel || "").trim();
if (!/^\d{15,25}$/.test(canal)) fail("Falta el ID del canal de los avisos. Cargalo en la página: Ligas → Discord → Configurar avisos.");
const emojis = parseEmojis(disc.dayEmojis != null ? disc.dayEmojis : "✅ 🟡 ❌");

const hoy = (process.env.FECHA || "").trim() || new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const avisos = avisosDelDia(datos, hoy);
console.log(`Fecha ${hoy}: ${avisos.length} partido(s).`);
if (!avisos.length) { console.log("No hay partidos programados para hoy: no se manda nada."); process.exit(0); }

let fallasReaccion = 0;
for (const a of avisos) {
  const msg = await api("POST", `/channels/${canal}/messages`, { content: a.content, allowed_mentions: { parse: [], roles: a.roles } });
  console.log("Mandado: " + a.preview);
  for (const e of emojis) {
    try { await api("PUT", `/channels/${canal}/messages/${msg.id}/reactions/${encodeURIComponent(e)}/@me`); await sleep(300); }
    catch (err) { fallasReaccion++; console.error(`No se pudo reaccionar con ${e}: ${err.message}`); }
  }
}
console.log(`Listo: ${avisos.length} aviso(s).` + (fallasReaccion ? ` ${fallasReaccion} reacción(es) fallaron.` : ""));

async function api(method, path, body) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(API + path, { method, headers: Object.assign({ Authorization: "Bot " + TOKEN, "User-Agent": "DarkEmpireBot (github actions, 1.0)" }, body ? { "Content-Type": "application/json" } : {}), body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { let w = 1; try { w = (await r.json()).retry_after || 1; } catch (e) {} await sleep(w * 1000 + 100); continue; }
    if (r.status === 401) fail("El token del bot no es válido (secret DISCORD_BOT_TOKEN).");
    if (r.status === 403) fail("El bot no tiene permiso en ese canal: necesita Ver canal, Enviar mensajes, Leer el historial, Añadir reacciones y Mencionar a todos.");
    if (r.status === 404 && method === "POST") fail("No encontré el canal: revisá el ID en la página (Ligas → Discord).");
    if (!r.ok) throw new Error(`Discord ${r.status}: ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  }
  throw new Error("Discord limitó los envíos.");
}
async function leer(url) {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) fail(`No se pudo leer Firebase (${res.status}): ${await res.text()}`);
  return decodeFields((await res.json()).fields || {});
}
function decodeFields(f) { const o = {}; for (const k in f) o[k] = decode(f[k]); return o; }
function decode(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode);
  return null;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fail(msg) { console.error("ERROR: " + msg); process.exit(1); }
