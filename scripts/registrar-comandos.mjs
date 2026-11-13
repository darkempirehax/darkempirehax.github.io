// Registra (o actualiza) los comandos de barra del bot en Discord.
// Lo corre GitHub Actions: Actions → "Registrar comandos del bot" → Run workflow (pide el Application ID).
// Usa el mismo secret DISCORD_BOT_TOKEN que los avisos.
const TOKEN = (process.env.DISCORD_BOT_TOKEN || "").trim();
const APP = (process.env.APP_ID || "").trim();
if (!TOKEN) fail("Falta el secret DISCORD_BOT_TOKEN.");
if (!/^\d{15,25}$/.test(APP)) fail("Falta el Application ID (es un número, está en el portal de Discord → General Information).");

const jugador = (name, description) => ({ type: 3, name, description, required: false, autocomplete: true });
const commands = [
  { name: "pregunta", description: "Hacele una pregunta al oráculo del club", options: [{ type: 3, name: "texto", description: "Tu pregunta", required: true, max_length: 300 }] },
  { name: "mvp", description: "¿Quién es el MVP del club? (sorteo 100% transparente)" },
  { name: "culpable", description: "¿Quién es el culpable de la derrota?" },
  { name: "profecia", description: "Profecía del próximo partido (una sola por partido)" },
  { name: "apodo", description: "Le inventa un apodo a un jugador", options: [jugador("jugador", "Jugador del plantel (vacío = al azar)")] },
  { name: "1v1", description: "Mano a mano entre dos jugadores, con relato", options: [jugador("jugador1", "Primer jugador (vacío = al azar)"), jugador("jugador2", "Segundo jugador (vacío = al azar)")] },
  { name: "dt", description: "Charla técnica de Roncaglia, Langodni o Papillo" },
  { name: "horoscopo", description: "Horóscopo haxballero del día", options: [jugador("jugador", "Jugador del plantel (vacío = al azar)")] },
  { name: "goleadores", description: "Top 5 de goleadores del club" },
  { name: "asistidores", description: "Top 5 de asistidores del club" },
  { name: "miembros", description: "Lista etiquetando a todos los que tienen un rol (cuerpo técnico)", dm_permission: false, options: [
    { type: 8, name: "rol", description: "El rol", required: true },
  ] },
  { name: "host", description: "Manda por MD el link y la pw del ofi a los jugadores de una liga (cuerpo técnico)", dm_permission: false, options: [
    { type: 3, name: "link", description: "Link del host de Haxball", required: true, max_length: 200 },
    { type: 3, name: "liga", description: "Liga (se lo manda a los que tienen su rol)", required: true, autocomplete: true },
    { type: 3, name: "pw", description: "Contraseña del host (dejalo vacío si no tiene)", required: false, max_length: 50 },
  ] },
];

const r = await fetch(`https://discord.com/api/v10/applications/${APP}/commands`, {
  method: "PUT",
  headers: { Authorization: "Bot " + TOKEN, "Content-Type": "application/json", "User-Agent": "DarkEmpireBot (github actions, 1.0)" },
  body: JSON.stringify(commands),
});
if (!r.ok) fail(`Discord respondió ${r.status}: ${await r.text()}`);
console.log(`Listo: ${commands.length} comandos registrados (${commands.map(c => "/" + c.name).join(" ")}). Pueden tardar unos minutos en aparecer en Discord.`);
function fail(m) { console.error("ERROR: " + m); process.exit(1); }
