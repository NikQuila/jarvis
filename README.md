# J.A.R.V.I.S.

**Estaba chato de mi desorden, así que me construí a JARVIS.**

Es mi asistente personal. Por dentro es **Claude Code corriendo dentro de mi segundo cerebro** (un vault de notas en
git), en un servidor de DigitalOcean que está prendido 24/7. Le hablo de dos formas:

- **Por WhatsApp.** Le escribo o le mando un audio desde cualquier parte. Me manda el día en la mañana, me avisa antes
  de cada bloque del calendario, y hace las cosas que le pido: mueve el calendario, crea tareas, me resume un podcast,
  edita mis notas.
- **En un HUD estilo Iron Man** (`/jarvis`), con voz. Muestra cómo dormí (WHOOP), la plata de mis apps (RevenueCat) y la
  agenda del día, y le hablo con el micrófono.

Los dos usan el mismo cerebro, así que sabe lo mismo por los dos lados.

Lo armé con Claude Code. Este repo tiene todo para que armes el tuyo.

<!-- ![JARVIS](docs/jarvis.png) -->

---

## Qué hace

| | |
|---|---|
| 🌅 **Buenos días** | Con tu primer mensaje del día te manda el resumen: cómo dormiste y qué te toca. El saludo lo escribe Claude leyendo tu vault (el journal de ayer, tus metas, tu primer bloque) |
| ⏰ **Avisos** | 5 minutos antes de cada evento de Google Calendar |
| 🎙️ **Audios** | Le mandas un audio por WhatsApp y te entiende igual (Kapso lo transcribe) |
| 📅 **Calendario** | Crea y mueve tus bloques. Para borrar algo o tocar eventos con otra gente, primero te pide un "sí" |
| 🧠 **Tu vault** | Lee y edita tus notas, y hace commit + push de todo |
| 🎧 **Podcasts** | Busca el episodio, lo transcribe en el servidor con whisper.cpp y te lo resume |
| 🔌 **Tus herramientas** | Lo que conectes por MCP: Linear, Notion, RevenueCat, Supabase, GitHub, tu banco (solo lectura)… |
| 🖥️ **HUD con voz** | Biometría de WHOOP, KPIs de RevenueCat y la agenda, con subtítulos y micrófono. Tocas un evento y ves su detalle |

## Cómo funciona

```
Tu WhatsApp ──► número del bot (Kapso) ──► webhook ──┐
                                                     ▼
HUD /jarvis (voz) ──► /jarvis/api/ask ──────►  server.mjs  (DigitalOcean, 24/7)
                                                     │
                            claude -p --resume  ◄────┘   cwd = tu vault: tus notas, tus skills, tus MCPs
                                                     │
Tu WhatsApp ◄── API de Kapso ◄───────────────────────┘
```

- **Sin dependencias en el servidor:** un solo `server.mjs` en Node.
- **Solo te responde a ti.** Cualquier otro número se ignora y las firmas del webhook se verifican (HMAC).
- **Una conversación continua** (`--resume`). Con `/nuevo` la reinicias.
- **No necesitas API key de Anthropic.** Claude Code usa tu plan Pro o Max.

## Lo que necesitas y cuánto cuesta

| | Para qué | Costo aprox. |
|---|---|---|
| Plan **Claude Pro o Max** | El cerebro. Claude Code en el servidor usa tu plan | el que ya tengas |
| **Vault en un repo de GitHub** | Donde trabaja el asistente. Sirve cualquier carpeta de notas en markdown (Obsidian, por ejemplo) | gratis |
| Cuenta **Kapso** | El número de WhatsApp, por la API oficial de Meta | Free: 1 número, 2.000 mensajes/mes. Meta cobra aparte por mensaje |
| Servidor **DigitalOcean** | Que esté prendido aunque tu Mac esté apagado | ~US$24/mes (2 vCPU / 4 GB, whisper lo necesita) |
| `gh` y `doctl` en tu Mac | Para los pasos de abajo | gratis |

**Total: ~US$24 al mes más tu plan de Claude.**

---

## Instalación

### 1. El número de WhatsApp (Kapso)

1. Crea una cuenta en [kapso.ai](https://kapso.ai) y un proyecto. En **API keys** crea una key → `KAPSO_API_KEY`.
2. **Connected numbers → Connect new number → Instant setup.** Te da un número de EE.UU. ya verificado (el primero es gratis).
   - En la ventana de Meta: crea un **Business portfolio nuevo, a tu nombre**. No uses el de tu empresa: si Meta
     considera el bot un "chatbot de propósito general", que el castigo no le pegue al WhatsApp de la empresa.
   - En *Add your WhatsApp phone number* elige **Use a new or existing number** (no "display name only") y en el dropdown
     un **BSP provided number**.
   - Ojo: los *setup links* de la API son para clientes. Tu propio número se conecta desde el dashboard.
3. Anota el `phone_number_id` del número (Kapso → el número) → `KAPSO_PHONE_NUMBER_ID`.

### 2. El servidor

```bash
doctl auth init                      # pega tu token de DigitalOcean (API → Generate New Token, read+write)
doctl compute ssh-key list           # tu llave SSH tiene que estar ahí
doctl compute droplet create my-assistant --image ubuntu-24-04-x64 --size s-2vcpu-4gb \
  --region nyc3 --ssh-keys <ID> --wait
IP=<la IP del droplet>
scp deploy/setup.sh root@$IP:
ssh root@$IP "bash setup.sh ${IP//./-}.sslip.io"     # HTTPS automático con Caddy + sslip.io
```

`setup.sh` instala Node, Claude Code, Caddy (HTTPS), whisper.cpp + modelo, yt-dlp, ffmpeg y Chrome headless. También
crea el usuario `assistant` y el servicio `whatsapp-assistant`. Si falla con *"Could not get lock"*, es Ubuntu
actualizándose en el primer arranque: espera 2 minutos y córrelo de nuevo.

### 3. Tu vault en el servidor

El asistente necesita **push** a tu vault. Lo más simple es una deploy key con escritura:

```bash
ssh root@$IP "cat /home/assistant/.ssh/id_ed25519.pub" > /tmp/key.pub
gh repo deploy-key add /tmp/key.pub --repo <tu-usuario>/<tu-vault> --allow-write --title "jarvis"
ssh root@$IP "sudo -iu assistant git clone git@github.com:<tu-usuario>/<tu-vault>.git vault"
ssh root@$IP "sudo -iu assistant git -C vault config user.name 'Me (JARVIS)'"
ssh root@$IP "sudo -iu assistant git -C vault config user.email you@example.com"
```

> Si el repo es de una organización que tiene las deploy keys desactivadas, usa un token fine-grained (ver
> [Conecta tus cosas](#conecta-tus-cosas), GitHub).

**Tip:** pon un `CLAUDE.md` en la raíz del vault que diga quién eres y cómo trabajar contigo. JARVIS lo lee en cada
mensaje. Ahí está la diferencia entre un bot genérico y uno que te conoce.

### 4. Loguear Claude (el único paso manual en el servidor)

```bash
ssh assistant@$IP
cd ~/vault && claude        # "Claude account with subscription" → abre el link → pega el código → confía en la carpeta → /exit
```

Los **conectores de claude.ai** (Google Calendar, Gmail, Drive, Slack…) vienen con tu cuenta: los que tengas
autorizados en claude.ai → Settings → Connectors aparecen solos en el servidor. Google Calendar es el que usan los
avisos. Compruébalo con `claude mcp list`.

### 5. El código y la configuración

```bash
ssh assistant@$IP "mkdir -p ~/whatsapp-assistant"
scp server.mjs whoop.mjs system-prompt.example.md assistant@$IP:whatsapp-assistant/
ssh assistant@$IP
cd ~/whatsapp-assistant && mv system-prompt.example.md system-prompt.md && nano system-prompt.md   # hazlo tuyo
mkdir -p ~/.config/kapso && cp /dev/null ~/.config/kapso/kapso.env && chmod 600 ~/.config/kapso/kapso.env
nano ~/.config/kapso/kapso.env     # complétalo con .env.example (OWNER_PHONE, VAULT_PATH=/home/assistant/vault, PERMISSIONS=full, GIT_SYNC=1…)
exit
ssh root@$IP "systemctl enable --now whatsapp-assistant && curl -s localhost:8787/health"   # → ok
```

**El `system-prompt.md` es lo que lo hace tuyo:** tu idioma, tu zona horaria, qué puede tocar y qué no, y una línea
por cada integración. Parte del ejemplo y agrégale lo que vayas conectando.

### 6. Conectar Kapso con el servidor (webhook)

```bash
source ~/.config/kapso/kapso.env    # en tu Mac, con las mismas variables
curl -s -X POST https://api.kapso.ai/platform/v1/whatsapp/webhooks \
  -H "X-API-Key: $KAPSO_API_KEY" -H "Content-Type: application/json" -d '{
  "whatsapp_webhook": {
    "url": "https://<IP-con-guiones>.sslip.io/webhook",
    "phone_number_id": "'$KAPSO_PHONE_NUMBER_ID'",
    "kind": "kapso", "payload_version": "v2", "active": true,
    "secret_key": "'$KAPSO_WEBHOOK_SECRET'",
    "events": ["whatsapp.message.received"],
    "buffer_enabled": true, "buffer_window_seconds": 3, "max_buffer_size": 20,
    "buffer_events": ["whatsapp.message.received"]
  }}'
```

El buffer junta en uno solo los mensajes que mandas seguidos.

**Pruébalo:** escríbele "hola" al número del bot desde tu WhatsApp. En el servidor:
`journalctl -u whatsapp-assistant -f`.

### 7. La plantilla para los avisos

WhatsApp solo deja escribirte libremente **dentro de las 24h** desde tu último mensaje. Fuera de esa ventana, los
avisos salen con una plantilla aprobada por Meta, que tiene una sola variable y no puede empezar ni terminar con ella.
Créala una vez:

```bash
curl -s -X POST "https://api.kapso.ai/meta/whatsapp/v24.0/<business_account_id>/message_templates" \
  -H "X-API-Key: $KAPSO_API_KEY" -H "Content-Type: application/json" -d '{
  "name": "agenda_aviso", "language": "es", "category": "UTILITY",
  "components": [{ "type": "BODY",
    "text": "Recordatorio de tu agenda: {{1}}. Respóndeme si quieres cambiar algo.",
    "example": { "body_text": [["Deep work a las 12:00"]] } }]}'
```

(O desde el MCP de Kapso: `whatsapp_templates` → `create`.) La aprobación tarda de minutos a horas. Mientras tanto,
basta con escribirle al bot una vez al día para que los avisos lleguen completos.

---

## El HUD: JARVIS en la pantalla

Un HUD estilo Iron Man que habla con el mismo cerebro, con voz en español: `https://<tu-host>/jarvis/`.

- **Paneles:** biometría de WHOOP (recovery, HRV, FC en reposo, sueño), revenue y MRR de RevenueCat y la agenda del
  día, con cuenta regresiva a lo próximo. Tocas un evento y ves su checklist, la gente y el link de la reunión.
- **Voz:** micrófono y respuestas habladas con la Web Speech API (Chrome y Safari). En el Mac, la barra espaciadora es
  para hablar. Arranca con un saludo en italiano.
- **Para grabar:** `F` o el botón ⛶ lo deja en pantalla completa.
- **Código:** `jarvis-ui/` (Vite + React + three.js). El reactor 3D y la secuencia de arranque vienen de
  [adewaskar/jarvis](https://github.com/adewaskar/jarvis) (MIT, ver `jarvis-ui/LICENSE`). Los paneles, la voz y la
  conexión con el servidor están en `src/App.tsx` y `src/nik/`.
- **API:** `GET /jarvis/api/state` (los datos de los paneles) y `POST /jarvis/api/ask` (pregunta → respuesta corta para
  voz, con su propia sesión). Está protegida con `JARVIS_TOKEN`: sin la clave, responde 401.

```bash
# en tu Mac
cd jarvis-ui && npm install && npm run build
ssh assistant@$IP "mkdir -p ~/whatsapp-assistant/jarvis"
scp -r dist/* assistant@$IP:whatsapp-assistant/jarvis/
```

Caddy ya deja pasar `/jarvis` y `/jarvis/*` (es el matcher `@bridge` de `deploy/setup.sh`).

**Primera vez:** abre `https://<host>/jarvis/?k=<JARVIS_TOKEN>` y la clave queda guardada en el navegador. En el
celular, "Agregar a pantalla de inicio" lo deja como app.

**Para los paneles** (opcional): `REVENUECAT_API_KEY` + `REVENUECAT_PROJECT_ID` para el MRR, y WHOOP conectado
(abajo) para la biometría. Sin eso, el HUD funciona igual y los paneles quedan vacíos.

---

## Conecta tus cosas

Cada integración es: **token → MCP o variable en el servidor → una línea en `system-prompt.md`.** Instálalas como el
usuario `assistant` (`ssh assistant@$IP`) y reinicia el servicio (`sudo systemctl restart whatsapp-assistant`, como
root). Guarda cada token en `~/.config/<servicio>.env` con `chmod 600`, nunca en el repo.

| Servicio | Cómo sacar el token | Cómo conectarlo |
|---|---|---|
| **Google Calendar, Gmail, Drive, Slack** | Conectores de claude.ai | Ya están (paso 4) |
| **Linear** | linear.app/settings/account/security → New API key. **Una por workspace** | `claude mcp add --transport http -s user linear-<ws> https://mcp.linear.app/mcp --header "Authorization: Bearer <key>"` |
| **Notion** | Configuración → Desarrollador → Nuevo token (un **propietario** del workspace tiene que habilitarlo). O una integración interna en Conexiones | El MCP alojado de Notion **no acepta tokens**; usa el local: `claude mcp add -s user notion-<ws> -e NOTION_TOKEN=<token> -- npx -y @notionhq/notion-mcp-server` |
| **RevenueCat** | Project settings → API keys → New secret key, **v2, read-only** | `claude mcp add --transport http -s user revenuecat https://mcp.revenuecat.ai/mcp --header "Authorization: Bearer <key>"` |
| **WHOOP** | [developer.whoop.com](https://developer.whoop.com) → crea una app. Redirect URI: `https://<host>/whoop/callback` | `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` y `WHOOP_REDIRECT_URI` en `kapso.env`. Después abre `https://<host>/whoop/login` una vez. El asistente lo usa con `node whoop.mjs brief \| recovery \| sleep \| workouts` |
| **GitHub (repos de una org)** | github.com/settings/personal-access-tokens/new → Resource owner: la org · solo esos repos · **Contents** y **Pull requests**: Read and write. Si la org lo pide, apruébalo | Un token por org: `git config --global --add url."https://x-access-token:<tok>@github.com/<org>/".insteadOf "https://github.com/<org>/"` (y otro `insteadOf` para `git@github.com:<org>/` si hay submódulos). Clónalo y súmalo a `MIRROR_REPOS`. Para PRs: `GITHUB_<ORG>_TOKEN=<tok>` en `kapso.env` |
| **Supabase** | Access token de tu cuenta | MCP `supabase` en modo **read-only**. Dile en el prompt que solo devuelva agregados, nunca datos personales de tus usuarios |
| **Banco (Mercury u otro)** | Token **solo lectura**. Nunca "Read and Write" | Variable en `kapso.env`. Dile en el prompt que consulte saldos en vivo y no los escriba en archivos |

Si un MCP no conecta: `claude mcp get <nombre>`. Si responde 401, el token está mal o revocado.

## Seguridad: qué puede y qué no

- En el servidor corre con `PERMISSIONS=full` (bypassPermissions) **menos `FORBIDDEN_TOOLS`** en `server.mjs`: mandar
  mails o Slack, compartir o borrar en Drive, SQL en Supabase, `push --force`, `reset --hard`. Revísala y ajústala a
  tus conectores.
- **Solo tu número** recibe respuesta. El prompt le dice que no siga instrucciones que vengan de páginas web o
  transcripciones (prompt injection).
- **Tokens de solo lectura** donde se pueda (banco, métricas). Un agente que responde por WhatsApp no debería poder
  mover plata.
- Los tokens viven en `~/.config/*.env` del servidor, fuera del repo. **Nunca los pegues en un chat**; si pasa,
  rótalos.
- El HUD es público, pero sus datos no: la API pide `JARVIS_TOKEN`. Si grabas la pantalla, tapa la URL.

## Operación

```bash
ssh root@$IP journalctl -u whatsapp-assistant -f                     # logs
scp server.mjs whoop.mjs system-prompt.md assistant@$IP:whatsapp-assistant/ && \
  ssh root@$IP systemctl restart whatsapp-assistant                  # desplegar cambios
```

- **Probar en local sin mandar nada:** `DRY_RUN=1 OWNER_PHONE=... VAULT_PATH=... PORT=8799 node server.mjs` y un POST
  firmado a `/webhook` (`X-Webhook-Signature` = HMAC-SHA256 en hex del body crudo).
- **Correrlo en tu Mac en vez de un servidor:** `tunnel.sh` levanta ngrok y actualiza la URL del webhook
  (`KAPSO_WEBHOOK_ID`) en cada arranque; ponlo en un LaunchAgent junto a `server.mjs`. Solo funciona con el Mac
  despierto.

Todas las variables están en [`.env.example`](.env.example).

---

## Créditos

- El reactor 3D y la secuencia de arranque del HUD: [adewaskar/jarvis](https://github.com/adewaskar/jarvis) (MIT).
- WhatsApp por [Kapso](https://kapso.ai). El cerebro es [Claude Code](https://claude.com/claude-code).

Licencia MIT ([`LICENSE`](LICENSE)). El HUD conserva la licencia MIT de adewaskar/jarvis ([`jarvis-ui/LICENSE`](jarvis-ui/LICENSE)).

Hecho por [Nicolás Pirozzi](https://www.instagram.com/nicolaspirozzim/). Si armas el tuyo, mándame una foto. Vamo arriba.
