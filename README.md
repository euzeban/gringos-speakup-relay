# Gringos SpeakUp Live Relay

Relay WebSocket seguro entre o navegador e o **Gemini Live (`gemini-3.1-flash-live-preview`, v1beta)** para o SpeakUp.
Motivo: esse modelo (que mantém o personagem de verdade) só funciona em v1beta + API key, e o token efêmero é v1alpha. O relay segura a chave Gemini no servidor e expõe só um WebSocket autenticado por token curto (HMAC) emitido pelo app.

```
Navegador (SpeakUp)  --wss + token-->  ESTE relay (VPS)  --apiKey v1beta-->  Gemini Live 3.1
```

## Variáveis de ambiente (Easypanel)
| Var | Valor |
|-----|-------|
| `GEMINI_API_KEY` | a mesma chave Gemini do app (`AIza...`) |
| `SPEAKUP_RELAY_SECRET` | segredo compartilhado com o app (MESMA string nos dois lados, app + relay). O Bilbo te passa o valor no chat; nunca fica no repositório. |
| `ALLOWED_ORIGINS` | `https://dashboard.gringosacademy.com,https://app.gringosacademy.com` |
| `LIVE_MODEL` | `gemini-3.1-flash-live-preview` (opcional, já é o default) |
| `PORT` | `8080` |

## Deploy no Easypanel (passo a passo)
1. No Easypanel, **Create > App** (ou Service). Nome: `gringos-speakup-relay`.
2. Source: aponte pro repositório deste projeto (GitHub) OU faça upload. Build = **Dockerfile** (já incluso).
3. Em **Environment**, cole as variáveis da tabela acima.
4. Em **Domains/Proxy**: exponha a porta **8080** e atribua um domínio, ex.: `speakup-relay.mauroserver.cloud`. Ative TLS (Let's Encrypt). O relay vai responder em `wss://speakup-relay.mauroserver.cloud/speakup`.
   - Se usar Cloudflare na frente: o registro do subdomínio pode ficar **proxied** (Cloudflare suporta WebSocket); se der problema de upgrade, troque pra **DNS only**.
5. Deploy. Teste a saúde: `https://speakup-relay.mauroserver.cloud/health` deve retornar `ok`.
6. Me passe a URL final (`wss://.../speakup`). Eu coloco no app como `SPEAKUP_RELAY_URL` e subo o app.

## No app Next (Vercel) — eu configuro, você só confirma os env
- `SPEAKUP_RELAY_SECRET` = o MESMO segredo acima.
- `SPEAKUP_RELAY_URL` = `wss://speakup-relay.mauroserver.cloud/speakup`.

## Rodar local (teste)
```
npm install
GEMINI_API_KEY=... SPEAKUP_RELAY_SECRET=... node server.mjs
```

## Protocolo (browser <-> relay)
- Cliente conecta em `wss://.../speakup?token=<tokenHMAC>`.
- 1ª msg do cliente: `{ "type":"setup", "voice":"Charon", "systemInstruction":"..." }` → relay abre o Gemini.
- Áudio do mic: `{ "type":"audio", "data":"<base64 pcm16 16kHz>", "mimeType":"audio/pcm;rate=16000" }`.
- Relay → cliente: `{ "type":"open" }`, `{ "type":"message", "payload": <serverContent do Gemini> }`, `{ "type":"error" }`, `{ "type":"gemini_close" }`.
- A reconexão é do lado do cliente (reabre o WS + reenvia o setup).
