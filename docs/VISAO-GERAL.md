# Suporte Remoto — Visão Geral

## Objetivo

Este serviço é o backend de tempo real que sustenta o **suporte remoto por
co-browsing** do produto One. Ele permite que **um ou mais atendentes**
acompanhem — e, quando autorizado, controlem — a tela de um **usuário**
diretamente dentro da aplicação web, sem compartilhamento de vídeo e sem
WebRTC.

Em vez de transmitir pixels, a sessão trafega **eventos semânticos**: mudanças
de rota, posição de scroll, movimento de ponteiro, cliques e comandos de
controle. Cada lado reconstrói a interface a partir desses eventos, o que torna
o tráfego leve e mantém o servidor como um simples **roteador de mensagens com
controle de estado e de permissões**.

O papel do servidor se resume a três responsabilidades:

1. **Orquestrar o ciclo de vida** de salas (lobbies) e convites — quem criou a
   sala, quem foi convidado, quem aceitou, quem confirmou, quando expira.
2. **Isolar e retransmitir** os eventos de co-browsing apenas entre os
   participantes legítimos de cada sala.
3. **Ser a fonte da verdade das permissões e do controle**: nada de controle
   remoto acontece sem a permissão da sala **e** sem que o atendente seja o
   piloto (`driverId`) atual.

Atualmente todo o estado vive **em memória**. não adicionamos BD

---

## Modelo mental: lobby de jogo

O usuário é sempre o **dono da sala** (`owner`). Ele cria a sala e envia
**convites individuais** — um por atendente escolhido. Cada atendente
aceita ou recusa **o seu próprio convite**, de forma independente dos demais.
A sala não depende de nenhum convite específico: ela existe assim que o dono a
cria, e permanece aberta enquanto o dono estiver presente, **mesmo que nenhum
atendente tenha entrado ainda** ou que atendentes entrem e saiam ao longo do
tempo.

Isso resolve a principal fonte de bugs do modelo anterior (1 sessão atrelada a
"o primeiro atendente que aceitou"): cada atendente tem seu próprio ciclo de
vida de convite, e a sala tem o seu, desacoplado.

---

## Conceitos

| Conceito | O que é |
|---|---|
| **Usuário / dono (`owner`)** | Quem cria a sala e convida atendentes. Precisa da permissão global `remote-support.request`. É sempre o `requester` da sala. |
| **Atendente (`agent`)** | Quem é convidado e presta suporte. Precisa da permissão global `remote-support.agent`. Uma sala pode ter **vários** atendentes simultâneos. |
| **Contexto (`ContextCode`)** | Fronteira multi-tenant. Informado no handshake; a lista de atendentes disponíveis é sempre filtrada por contexto. |
| **Sala (`SupportRoom`)** | O lobby em si — criado pelo dono, existe independentemente de qualquer convite. É onde vivem os participantes, eventos, logs, permissões e o piloto atual. |
| **Convite (`SupportInvite`)** | Um convite individual, direcionado a **um** atendente. Tem sua própria máquina de estados, isolada dos demais convites da mesma sala. |
| **Participante** | Uma pessoa dentro de uma sala, com papel `requester` (o dono) ou `agent`, estado de conexão e último heartbeat. |
| **Piloto (`driverId`)** | O **único** atendente autorizado a emitir comandos de controle remoto na sala em um dado momento. Token exclusivo, reivindicado explicitamente (`driver:claim`) e liberado (`driver:release`). |
| **Permissão de sessão** | Autorização concedida pelo dono *dentro* da sala: `ViewCoBrowsing`, `ControlCoBrowsing`, `ShowRemotePointer`. Vale para a sala inteira — o piloto arbitra *quem* usa o controle no momento. |

Um usuário pode ter **várias conexões** (abas) simultâneas: cada aba é um
socket, mas todas compartilham a mesma identidade e presença. Só quando a
**última** conexão cai é que o usuário é considerado offline.

---

## Modos de atendimento

O convite carrega um `mode` (herdado da sala) que descreve a intenção do
atendimento:

- `assisted` — o atendente observa e orienta.
- `shared` — atendimento compartilhado, potencialmente com controle.

O modo é metadado transportado ponta a ponta; o que efetivamente libera
controle é a **permissão de sessão** somada ao **token de piloto**, não o
modo.

---

## Modelo de permissões

Há dois níveis distintos e independentes:

**Permissões globais** (quem é quem), vindas do payload de registro:
- `remote-support.request` — pode criar salas.
- `remote-support.agent` — pode ser listado e convidado.

**Permissões de sessão** (o que os atendentes podem fazer *nesta* sala),
concedidas pelo dono. Elas têm **dependências**:

```
ControlCoBrowsing  ──implica──▶  ViewCoBrowsing
ShowRemotePointer  ──implica──▶  ViewCoBrowsing
```

- **Conceder** `ControlCoBrowsing` ou `ShowRemotePointer` concede
  automaticamente `ViewCoBrowsing` junto.
- **Revogar** `ViewCoBrowsing` derruba em cascata `ControlCoBrowsing` e
  `ShowRemotePointer`. Se o piloto atual perde `ControlCoBrowsing` por essa
  cascata, o token é liberado (`driver:changed` com `driverId: null`).

O servidor mantém, por sala, o conjunto de permissões **concedidas** e a fila
de **pendentes** (solicitadas por qualquer atendente, ainda não respondidas).
O evento `permission:state` é sempre emitido como a **fonte da verdade** — o
frontend não deve inferir o estado, apenas refletir esse evento.

### Piloto único (`driverId`)

Mesmo com `ControlCoBrowsing` concedida à sala, **só um atendente por vez**
pode efetivamente emitir comandos (`remote:command`). O controle é um token
exclusivo:

- `driver:claim` — um atendente com `ControlCoBrowsing` reivindica o token.
  Falha com `DRIVER_BUSY` se outro atendente já é o piloto.
- `driver:release` — o piloto libera o token voluntariamente.
- Sem piloto definido, `remote:command` é **descartado silenciosamente**
  (fire-and-forget, sem ack) — não há reivindicação implícita por primeiro
  comando.
- O piloto é liberado automaticamente quando: ele sai da sala
  (`room:leave`), desconecta, ou a permissão `ControlCoBrowsing` é revogada.
- `driver:changed` é retransmitido para toda a sala a cada mudança.

---

## Ciclo de vida

### Máquina de estados da sala

```
open      ← criada pelo dono no room:create, já com ele como participante
   │
   │  dono convida mais atendentes a qualquer momento (room:invite)
   │  atendentes entram e saem livremente (invite:approve / room:leave)
   │
   ▼
closed | expired   ← dono encerra (room:close) ou fica sem heartbeat (sweeper)
```

A sala **não** tem estado intermediário de "aguardando aprovação" — isso vive
inteiramente no convite. A sala está `open` desde a criação; co-browsing e
presence já fluem entre o dono e qualquer atendente que já tenha entrado,
mesmo com outros convites ainda pendentes.

### Máquina de estados do convite (por atendente, independente)

```
pending
   │  atendente aceita         │ atendente recusa → declined
   ▼                            │ TTL 60s sem resposta → expired
awaiting_owner_approval         │ dono cancela → cancelled
   │  dono aprova (approved)    │ dono nega (approved:false) → denied
   ▼                            │ TTL 90s sem resposta → expired (approval_timeout)
joined  ── atendente sai / desconecta em definitivo ──► left
```

Cada convite tem seu próprio temporizador e sua própria notificação. A recusa
ou expiração de um convite **não afeta** os demais convites da mesma sala nem
a sala em si.

Motivos de encerramento registrados em `finishReason` do convite: `expired`,
`approval_timeout`, `declined_by_agent`, `denied_by_owner`,
`cancelled_by_owner`, `left_by_agent`, `room_closed`, `room_expired`.

---

## Fluxo completo (dois atendentes, um recusa)

```
Usuário (dono)                  Servidor                    Atendente B / C
  │  room:create {agentIds:[B,C]}  │                               │
  ├───────────────────────────────▶  cria sala open + 2 convites   │
  │  ◀── ack { room, invites } ────┤                               │
  │                                │  ── invite:received ─────────▶ B, C
  │                                │                               │
  │                                │      invite:decline (B)       │
  │  ◀──── invite:updated ─────────┼──────────────────────────────┤
  │                                │                               │
  │                                │      invite:accept (C)        │
  │  ◀── owner:approval_requested ─┼──────────────────────────────┤
  │  invite:approve {approved:true}│                               │
  ├───────────────────────────────▶  C entra na sala               │
  │                                │  ── participant:joined ──────▶ C
  │                                │                               │
  │  ══════════ eventos de co-browsing na sala room:{code} ══════ │
  │  presence:update / cobrowsing:event ──▶ retransmite ──▶ ambos  │
  │                                │                               │
  │  room:invite {agentIds:[D]}    │   (sala já ativa — dinâmico)  │
  ├───────────────────────────────▶  cria convite adicional        │
  │                                │  ── invite:received ─────────▶ D
  │                                │        (repete aceite/aprovação)
  │                                │                               │
  │                                │   driver:claim (C)            │
  │  ◀──────── driver:changed ─────┼──────── driver:changed ──────▶ C, D
  │  ◀── remote:command_received ──┤◀──────── remote:command ─────┤ C (piloto)
  │                                │       remote:command (D) ────┤ D → descartado
  │                                │                               │
  │                                │      room:leave (C)           │
  │  ◀──── participant:left ───────┼──────── participant:left ────▶ D
  │                                │                               │
  │  room:close                    │                               │
  ├───────────────────────────────▶  encerra, esvazia a sala       │
  │  ◀──────── room:closed ────────┼──────── room:closed ─────────▶ D
```

---

## Protocolo de mensagens

### Envelope e confirmação

Todo evento **client → server** viaja no envelope:

```json
{ "operationTrace": "<string de rastreio>", "data": { ... } }
```

Eventos com confirmação respondem via **ack**:

```json
{ "ok": true,  "data": { ... } }
{ "ok": false, "error": { "code": "...", "message": "...", "detail": ... } }
```

O `operationTrace` é opaco ao servidor e serve para correlação/telemetria; nos
eventos de co-browsing ele é preservado no histórico.

### Client → Server (com ack)

| Evento | `data` | ack `data` |
|---|---|---|
| `support:register` | `{ userId, name, email?, avatar?, permissions? }` | `{ user, bootstrap }` |
| `support:agents:list` | — | `{ agents }` |
| `room:create` | `{ agentIds, mode, permissions? }` | `{ room, invites }` |
| `room:invite` | `{ roomCode, agentIds }` | `{ room, invites }` |
| `room:leave` | `{ roomCode }` | — |
| `room:close` | `{ roomCode }` | — |
| `room:heartbeat` | `{ roomCode }` | — |
| `invite:accept` | `{ inviteId }` | `{ invite, room }` |
| `invite:decline` | `{ inviteId }` | `{ invite }` |
| `invite:cancel` | `{ inviteId }` | `{ invite }` |
| `invite:approve` | `{ inviteId, approved }` | `{ invite, room }` |
| `driver:claim` | `{ roomCode }` | `{ roomCode, driverId }` |
| `driver:release` | `{ roomCode }` | `{ roomCode, driverId }` |
| `permission:request` | `{ roomCode, permissions }` | `{ roomCode, permissions, pendingPermissions }` |
| `permission:cancel` | `{ roomCode, permissions }` | idem |
| `permission:grant` | `{ roomCode, permissions }` | idem |
| `permission:revoke` | `{ roomCode, permissions }` | idem |

### Client → Server (sem ack — fire-and-forget)

Erros aqui são apenas logados; não há resposta. São eventos de alta frequência
ou best-effort:

| Evento | `data` |
|---|---|
| `presence:update` | `{ roomCode, cursorX?, cursorY?, route?, scrollX?, scrollY?, ... }` |
| `cobrowsing:event` | `{ roomCode, type, payload? }` |
| `remote:command` | `{ roomCode, type, targetSupportId?, route?, scroll*?, value?, at? }` — descartado se o emissor não for o piloto atual (`driverId`). |

### Server → Client

`support:bootstrap`, `agents:list`, `room:created` *(não emitido separadamente
hoje — o ack de `room:create` já entrega a sala)*, `room:closed`,
`invite:received`, `invite:updated`, `owner:approval_requested`,
`participant:joined`, `participant:left`, `driver:changed`, `presence:updated`,
`cobrowsing:event_received`, `log:appended`, `permission:requested`,
`permission:granted`, `permission:revoked`, `permission:state`,
`remote:command_received`.

---

## Salas e roteamento

O isolamento entre atendimentos é feito por **salas** (rooms do Socket.IO):

| Sala (transporte) | Quem está nela | Para quê |
|---|---|---|
| `user:{userId}` | Todas as conexões de um mesmo usuário | Entregar mensagens direcionadas a uma pessoa, independentemente da aba — inclusive convites, antes de a pessoa entrar na sala de suporte. |
| `ctx:{contextCode}` | Todos os registrados de um contexto | Broadcast da lista de atendentes. |
| `room:{code}` | Participantes efetivamente na sala (dono + atendentes que entraram) | Retransmitir presença, eventos de co-browsing, comandos de controle e mudanças de permissão/piloto. |

Eventos de co-browsing usam retransmissão **para a sala exceto o remetente**,
de modo que quem originou o evento não o recebe de volta. Convites e
aprovações são entregues via `user:{userId}`, pois o destinatário ainda não
está na sala `room:{code}`.

---

## Persistência efêmera e limites

- **Histórico da sala** é limitado em memória: no máximo 200 eventos de
  co-browsing e 200 logs por sala, sempre com os mais recentes no topo.
- **Eventos de alta frequência** (`scroll_changed`, `pointer_moved`) são
  retransmitidos, mas **não** geram entrada de log — evitando poluir o
  histórico. Os demais viram `log:appended`.
- A **mensagem legível** de um log de co-browsing é montada no frontend (que tem
  o contexto do DOM); o servidor guarda um fallback genérico.

---

## Tempos e expiração

O servidor aplica prazos automáticos e roda um **sweeper** periódico:

| Prazo | Valor | Efeito ao estourar |
|---|---|---|
| Resposta ao convite | 60 s | Convite em `pending` vira `expired`. |
| Aprovação do dono | 90 s | Convite aceito e não aprovado vira `expired` (`approval_timeout`). |
| Sala sem heartbeat do dono | 2 min | Sala aberta cujo **dono** está desconectado e sem heartbeat é encerrada como `expired`. |
| Intervalo do sweeper | 15 s | Frequência com que salas obsoletas são varridas. |

O sweeper avalia **apenas a conexão do dono** — um atendente desconectado
nunca encerra a sala; ele só fica marcado como offline (e, se era o piloto,
perde o token). Enquanto a sala está aberta, cada participante envia
`room:heartbeat` periodicamente.

---

## Resiliência de conexão

- **Reconexão.** Ao registrar novamente, o servidor recoloca o socket nas salas
  cujo participante já é conhecido, marca o participante como conectado e
  notifica os demais com `participant:joined`.
- **Queda de aba.** Enquanto restar ao menos uma conexão do usuário, ele
  continua online. Na queda da última, ele é marcado offline nas salas abertas
  de que participa; se era o piloto, o token é liberado
  (`driver:changed { driverId: null }`).
- **Saída explícita (`room:leave`).** Se quem sai é um atendente, a sala
  continua normalmente para o dono e os demais atendentes; o convite dele é
  marcado `left`. Se quem sai é o **dono**, a sala é encerrada
  (equivalente a `room:close`).

---

## Códigos de erro

Retornados no ack (`error.code`) quando um evento com confirmação falha:

| Código | Significado |
|---|---|
| `NOT_REGISTERED` | Socket ainda não fez `support:register`. |
| `INVALID_PAYLOAD` | Campos obrigatórios ausentes ou permissão de sessão inválida. |
| `FORBIDDEN` | Ação não permitida para o papel/permissão do solicitante. |
| `AGENT_NOT_FOUND` | Atendente informado não existe ou não é atendente. |
| `INVITE_NOT_FOUND` | Convite inexistente. |
| `ROOM_NOT_FOUND` | Sala inexistente. |
| `INVALID_STATE` | Transição incompatível com o estado atual do convite/sala. |
| `ALREADY_HAS_OPEN_ROOM` | O usuário já é dono de uma sala aberta (`room:create`; não se aplica a `room:invite`, que é o caminho para convidar mais gente numa sala já aberta). |
| `DRIVER_BUSY` | Outro atendente já é o piloto atual da sala. |
| `INTERNAL_ERROR` | Falha não prevista. |
