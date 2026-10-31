// Renueva el mensaje del calendario en Discord.
// Lo ejecuta GitHub Actions todos los días a la medianoche (.github/workflows/calendario-discord.yml)
// para que el mensaje empiece en el día nuevo aunque nadie haya editado nada.
// Durante el día, el mensaje lo actualiza la propia página cada vez que un capitán guarda algo.
//
// Configuración: Secret DISCORD_WEBHOOK_CALENDARIO (el webhook del canal del calendario).
import { readFileSync } from "node:fs";
import { renderCalendario, webhookValido } from "./calendario-render.js";

const TZ = "America/Argentina/Buenos_Aires";
const WEBHOOK = (process.env.DISCORD_WEBHOOK_CALENDARIO || "").trim();

const cfg = readFileSync(new URL("../config.js", import.meta.url), "utf8");
const projectId = (cfg.match(/projectId:\s*"([^"]+)"/) || [])[1];
if (!projectId) fail("config.js no tiene projectId.");
if (!webhookValido(WEBHOOK)) fail("Falta el secret DISCORD_WEBHOOK_CALENDARIO o no es un webhook de Discord válido.");

const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/club`;
const datos = await leer(`${base}/datos`);
const disc = await leer(`${base}/discord`);
if (!datos) fail("Todavía no hay datos cargados en la página.");
const msgId = disc && disc.calMsgId;
if (!msgId) fail("Todavía no se publicó el mensaje. Publicalo primero desde la página (Ligas → Discord).");

const hoy = (process.env.FECHA || "").trim() || new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const content = renderCalendario(datos, hoy);
console.log(content + "\n");

const r = await fetch(`${WEBHOOK}/messages/${msgId}`, {
  method: "PATCH", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
});
if (r.status === 404) fail("El mensaje ya no existe en Discord (¿lo borraron?). Volvé a publicarlo desde la página (Ligas → Discord).");
if (!r.ok) fail(`Discord rechazó la edición (${r.status}): ${await r.text()}`);
console.log("Mensaje del calendario actualizado.");

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
function fail(msg) { console.error("ERROR: " + msg); process.exit(1); }
