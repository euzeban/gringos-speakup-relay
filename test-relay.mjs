// Smoke test local do relay: sobe o relay, conecta como cliente com token válido,
// manda setup e espera o Gemini abrir (msg "open"). Valida auth + setup + connect.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";

const env = readFileSync("C:/Users/Mauro/gringos-auth-mvp/.env", "utf8");
const apiKey = env.match(/^GEMINI_API_KEY="?([^"\r\n]+)"?/m)?.[1]?.trim();
const SECRET = "testsecret123";
process.env.GEMINI_API_KEY = apiKey;
process.env.SPEAKUP_RELAY_SECRET = SECRET;
process.env.PORT = "8090";
process.env.ALLOWED_ORIGINS = "";

await import("./server.mjs");
await new Promise((r) => setTimeout(r, 600));

const payload = { uid: "test", exp: Date.now() + 120000 };
const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
const token = `${body}.${sig}`;

const done = (msg) => { console.log(msg); process.exit(0); };
const ws = new WebSocket(`ws://localhost:8090/speakup?token=${token}`);
let got = "";
const timer = setTimeout(() => done("TIMEOUT (sem 'open' em 15s). recebido: " + got), 15000);
ws.on("open", () => ws.send(JSON.stringify({ type: "setup", voice: "Charon", systemInstruction: "You are Ciarán, a real Dublin estate agent. Never say you are an AI." })));
ws.on("message", (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  got += m.type + ",";
  if (m.type === "open") { clearTimeout(timer); done("✅ RELAY OK: Gemini abriu pelo relay (auth + setup + connect funcionando)."); }
  if (m.type === "error") { clearTimeout(timer); done("❌ relay error: " + m.message); }
});
ws.on("error", (e) => { clearTimeout(timer); done("❌ ws error: " + (e?.message ?? e)); });

// teste de token inválido em paralelo (deve fechar com 1008)
setTimeout(() => {
  const bad = new WebSocket(`ws://localhost:8090/speakup?token=invalid.token`);
  bad.on("close", (code) => console.log(`  (token inválido -> fechou code ${code}, esperado 1008)`));
  bad.on("error", () => {});
}, 300);
