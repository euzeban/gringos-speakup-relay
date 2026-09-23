// Gringos SpeakUp Live Relay
// Browser (autenticado) <-> ESTE relay <-> Gemini Live (gemini-3.1-flash-live-preview, v1beta).
// A chave Gemini NUNCA vai pro navegador: fica só aqui. O navegador chega com um token
// curto assinado (HMAC) emitido pelo app Next (/api/speakup/live-token).
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";

const PORT = Number(process.env.PORT || 8080);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const RELAY_SECRET = process.env.SPEAKUP_RELAY_SECRET;
const MODEL = process.env.LIVE_MODEL || "gemini-3.1-flash-live-preview";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Detecção de fala (VAD). Sem isto o Gemini usa o padrão dele, que é sensível demais para
// aluno em casa: tosse, teclado, TV ou a própria voz da Aisling saindo pela caixa de som
// cortam a fala dela no meio. Relatado pelo Mauro em 23/09.
//   START baixo   = precisa de fala mais clara para o aluno tomar o turno
//   prefixPadding = quanto de som sustentado antes de valer como começo de fala
//   silenceDuration = quanto de silêncio antes de considerar que o aluno terminou
// Tudo por env, para calibrar sem tocar em código: uma conversa real vale mais que meu chute.
const VAD_START = process.env.VAD_START_SENSITIVITY || "START_SENSITIVITY_LOW";
const VAD_END = process.env.VAD_END_SENSITIVITY || "END_SENSITIVITY_HIGH";
const VAD_PREFIX_MS = Number(process.env.VAD_PREFIX_PADDING_MS || 300);
const VAD_SILENCE_MS = Number(process.env.VAD_SILENCE_MS || 700);

if (!GEMINI_API_KEY || !RELAY_SECRET) {
  console.error("[relay] faltando GEMINI_API_KEY ou SPEAKUP_RELAY_SECRET no ambiente.");
  process.exit(1);
}

// Token curto: base64url(payloadJSON).base64url(hmacSHA256). payload = { uid, exp }
function verifyToken(token) {
  try {
    if (!token || typeof token !== "string" || !token.includes(".")) return null;
    const [body, sig] = token.split(".");
    const expected = crypto.createHmac("sha256", RELAY_SECRET).update(body).digest("base64url");
    // timing-safe compare
    const a = Buffer.from(sig); const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload?.exp || Date.now() > Number(payload.exp)) return null;
    return payload;
  } catch { return null; }
}

function safeSend(ws, obj) {
  try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); } catch {}
}

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); return; }
  res.writeHead(426); res.end("upgrade required");
});

const wss = new WebSocketServer({ server: httpServer, path: "/speakup", maxPayload: 1024 * 1024 });

wss.on("connection", (client, req) => {
  // 1) Origin allowlist (se configurado)
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
    client.close(1008, "origin");
    return;
  }
  // 2) Auth via token na query
  let token = "";
  try { token = new URL(req.url, "http://x").searchParams.get("token") || ""; } catch {}
  const payload = verifyToken(token);
  if (!payload) { client.close(1008, "auth"); return; }

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY, httpOptions: { apiVersion: "v1beta" } });
  let session = null;
  let setupDone = false;

  client.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "setup" && !setupDone) {
      setupDone = true;
      const config = {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: msg.voice || "Charon" } } },
        systemInstruction: typeof msg.systemInstruction === "string" ? msg.systemInstruction : "",
        outputAudioTranscription: {},
        inputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: VAD_START,
            endOfSpeechSensitivity: VAD_END,
            prefixPaddingMs: VAD_PREFIX_MS,
            silenceDurationMs: VAD_SILENCE_MS,
          },
        },
      };
      console.log(
        `[relay] VAD: start=${VAD_START} end=${VAD_END} prefix=${VAD_PREFIX_MS}ms silence=${VAD_SILENCE_MS}ms`,
      );
      try {
        session = await ai.live.connect({
          model: MODEL,
          config,
          callbacks: {
            onopen: () => safeSend(client, { type: "open" }),
            onmessage: (m) => safeSend(client, { type: "message", payload: m }),
            onerror: (e) => safeSend(client, { type: "error", message: String(e?.message ?? e) }),
            onclose: (e) => safeSend(client, { type: "gemini_close", code: e?.code, reason: e?.reason }),
          },
        });
      } catch (err) {
        safeSend(client, { type: "error", message: "gemini connect failed: " + String(err?.message ?? err) });
        try { client.close(1011, "gemini connect failed"); } catch {}
      }
      return;
    }

    if (msg.type === "audio" && session) {
      // chunk PCM base64 do microfone -> Gemini.
      // Campo "audio" (NÃO "media"): o gemini-3.1-flash-live recusa media_chunks (deprecado,
      // close 1007). "audio" é o realtime audio input stream do SDK.
      try {
        session.sendRealtimeInput({ audio: { data: msg.data, mimeType: msg.mimeType || "audio/pcm;rate=16000" } });
      } catch {}
      return;
    }
  });

  const teardown = () => { try { session?.close?.(); } catch {} session = null; };
  client.on("close", teardown);
  client.on("error", teardown);
});

httpServer.listen(PORT, () => console.log(`[relay] SpeakUp relay ouvindo em :${PORT} (model=${MODEL})`));
