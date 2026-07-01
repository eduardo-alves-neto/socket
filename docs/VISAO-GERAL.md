# Suporte Remoto — Visão Geral

## Objetivo

Este serviço é o backend de tempo real que sustenta o **suporte remoto por
co-browsing** do produto One. Ele permite que um **atendente** acompanhe — e,
quando autorizado, controle — a tela de um **usuário** diretamente dentro da
aplicação web, sem compartilhamento de vídeo e sem WebRTC.

Em vez de transmitir pixels, a sessão trafega **eventos semânticos**: mudanças
de rota, posição de scroll, movimento de ponteiro, cliques e comandos de
controle. Cada lado reconstrói a interface a partir desses eventos, o que torna
o tráfego leve e mantém o servidor como um simples **roteador de mensagens com
controle de estado e de permissões**.

O papel do servidor se resume a três responsabilidades:

1. **Orquestrar o ciclo de vida** de chamados (tickets) e sessões — quem pediu,
   quem aceitou, quem confirmou, quando expira.
2. **Isolar e retransmitir** os eventos de co-browsing apenas entre os
   participantes legítimos de cada sessão.
3. **Ser a fonte da verdade das permissões**: nada de controle remoto acontece
   sem que o usuário tenha concedido a permissão correspondente.

Atualmente todo o estado vive **em memória**. não adicionamos BD
---

## Conceitos

| Conceito | O que é |
|---|---|
| **Usuário (requester)** | Quem pede ajuda. Precisa da permissão global `remote-support.request`. |
| **Atendente (agent)** | Quem presta suporte. Precisa da permissão global `remote-support.agent`. |
| **Contexto (`ContextCode`)** | Fronteira multi-tenant. Informado no handshake; a lista de atendentes disponíveis é sempre filtrada por contexto. |
| **Ticket** | Um convite de suporte direcionado a **um** atendente. Um pedido pode gerar vários tickets (um por atendente escolhido). |
| **Sessão** | O atendimento em si. Agrupa o usuário e os atendentes que efetivamente entraram. É onde vivem os eventos, os logs e as permissões. |
| **Participante** | Uma pessoa dentro de uma sessão, com papel `requester` ou `agent`, estado de conexão e último heartbeat. |
| **Permissão de sessão** | Autorização concedida pelo usuário *dentro* de uma sessão: `ViewCoBrowsing`, `ControlCoBrowsing`, `ShowRemotePointer`. |

Um usuário pode ter **várias conexões** (abas) simultâneas: cada aba é um
socket, mas todas compartilham a mesma identidade e presença. Só quando a
**última** conexão cai é que o usuário é considerado offline.

---

## Modos de atendimento

O ticket carrega um `mode` que descreve a intenção do atendimento:

- `assisted` — o atendente observa e orienta.
- `shared` — atendimento compartilhado, potencialmente com controle.

O modo é metadado transportado ponta a ponta; o que efetivamente libera controle
é a **permissão de sessão**, não o modo.

---

## Modelo de permissões

Há dois níveis distintos e independentes:

**Permissões globais** (quem é quem), vindas do payload de registro:
- `remote-support.request` — pode abrir chamados.
- `remote-support.agent` — pode ser listado e aceitar chamados.

**Permissões de sessão** (o que o atendente pode fazer *nesta* sessão),
concedidas pelo usuário durante o atendimento. Elas têm **dependências**:

```
ControlCoBrowsing  ──implica──▶  ViewCoBrowsing
ShowRemotePointer  ──implica──▶  ViewCoBrowsing
```

Isso significa que:

- **Conceder** `ControlCoBrowsing` ou `ShowRemotePointer` concede
  automaticamente `ViewCoBrowsing` junto.
- **Revogar** `ViewCoBrowsing` derruba em cascata `ControlCoBrowsing` e
  `ShowRemotePointer`.

O servidor mantém, por sessão, o conjunto de permissões **concedidas** e a fila
de **pendentes** (solicitadas pelo atendente, ainda não respondidas). O evento
`permission:state` é sempre emitido como a **fonte da verdade** — o frontend não
deve inferir o estado, apenas refletir esse evento.

---

## Ciclo de vida

### Máquina de estados do ticket

```
requested
   │  atendente aceita
   ▼
waiting_user_approval
   │  usuário confirma (approved: true)
   ▼
active
   │  encerramento / expiração / rejeição
   ▼
finished | expired | rejected
```

Motivos de saída registrados em `finishReason`: `expired` (ninguém aceitou a
tempo), `approval_timeout` (aceito, mas o usuário não confirmou),
`rejected_by_user`, `session_confirmed_without_response` (outro atendente foi
confirmado antes), ou `finished`.

### Máquina de estados da sessão

Um pedido cria **uma sessão** e **N tickets** (um por atendente). A sessão
avança conforme os tickets:

```
requested            ← criada junto com os tickets
   │  o PRIMEIRO atendente aceita
   ▼
waiting_user_approval
   │  usuário confirma
   ▼
active               ← participantes entram na sala, eventos fluem
   │
   ▼
finished | expired
```

Regras que valem a pena fixar:

- **O primeiro atendente a aceitar** move a sessão para
  `waiting_user_approval` e vira o `primaryTicket`. Atendentes que aceitam
  depois entram na mesma sessão sem reabrir a confirmação.
- Ao **confirmar**, todos os tickets ainda em `requested` são marcados como
  `expired` (`session_confirmed_without_response`) — o usuário já escolheu.
- Um atendente que aceita **quando a sessão já está `active`** entra
  diretamente, sem nova aprovação.
- A sessão só termina de fato quando **não há mais tickets abertos**.

---

## Fluxo completo

```
Usuário                         Servidor                        Atendente
  │  support:register              │                               │
  ├───────────────────────────────▶  registra, entra nas salas     │
  │  ◀── ack { user, bootstrap } ──┤                               │
  │                                │       support:register        │
  │                                ◀───────────────────────────────┤
  │                                │  ── agents:list (broadcast) ──▶│
  │                                │                               │
  │  ticket:create {agentIds,mode} │                               │
  ├───────────────────────────────▶  cria sessão + tickets         │
  │                                │  ──── ticket:created ────────▶ │
  │                                │                               │
  │                                │      ticket:accept            │
  │                                ◀───────────────────────────────┤
  │  ◀─ session:approval_requested ┤                               │
  │                                │                               │
  │  session:confirm {approved}    │                               │
  ├───────────────────────────────▶  ativa sessão, junta à sala    │
  │  ◀──────── session:active ─────┼──────── session:active ──────▶ │
  │                                │                               │
  │  ══════════ eventos de co-browsing na sala session:{code} ════ │
  │  presence:update / cobrowsing:event ──▶ retransmite ──▶ ambos   │
  │                                │                               │
  │                                │     permission:request        │
  │  ◀──── permission:requested ───┼───────────────────────────────┤
  │  permission:grant              │                               │
  ├───────────────────────────────▶  atualiza estado               │
  │  ◀── permission:state (verdade) ──── permission:state ────────▶ │
  │                                │                               │
  │                                │  remote:command (se Control)  │
  │  ◀── remote:command_received ──┤◀──────────────────────────────┤
  │                                │                               │
  │  session:finish                │                               │
  ├───────────────────────────────▶  encerra, esvazia a sala       │
  │  ◀──────── session:finished ───┼──────── session:finished ────▶ │
```

Narrado em prosa:

1. **Registro.** Cada lado envia `support:register` com sua identidade e
   permissões. O servidor coloca o socket nas salas `user:{id}` e
   `ctx:{contextCode}`, responde com o `bootstrap` (estado corrente relevante ao
   usuário) e faz broadcast da lista de atendentes atualizada.
2. **Pedido.** O usuário escolhe um ou mais atendentes e envia `ticket:create`.
   O servidor recusa se o usuário já tiver um atendimento em andamento.
3. **Aceite.** Cada atendente recebe `ticket:created` e pode aceitar. O primeiro
   aceite dispara `session:approval_requested` para o usuário.
4. **Confirmação.** O usuário aprova (ou recusa) via `session:confirm`. Na
   aprovação, todos os participantes entram na sala `session:{code}` e recebem
   `session:active`.
5. **Co-browsing.** A partir daí, `presence:update` e `cobrowsing:event` são
   retransmitidos **apenas dentro da sala** da sessão. O servidor não interpreta
   o conteúdo — apenas roteia e arquiva um histórico limitado.
6. **Permissões.** O atendente pede permissões (`permission:request`); o usuário
   concede/revoga (`permission:grant` / `permission:revoke`). Após cada mudança,
   o servidor emite `permission:state`.
7. **Controle remoto.** Com `ControlCoBrowsing` concedida, o `remote:command` do
   atendente é entregue ao usuário como `remote:command_received`. Sem a
   permissão, o comando é silenciosamente descartado.
8. **Encerramento.** Qualquer participante encerra com `session:finish`; todos
   recebem `session:finished` e a sala é dissolvida.

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
| `ticket:create` | `{ agentIds? \| agentId?, mode, permissions? }` | `{ ticket, tickets, session }` |
| `ticket:accept` | `{ ticketId }` | `{ ticket, session }` |
| `session:confirm` | `{ sessionCode, approved }` | `{ ticket, session }` |
| `session:finish` | `{ sessionCode, reason? }` | — |
| `session:heartbeat` | `{ sessionCode }` | — |
| `permission:request` | `{ sessionCode, permissions }` | `{ sessionCode, permissions, pendingPermissions }` |
| `permission:cancel` | `{ sessionCode, permissions }` | idem |
| `permission:grant` | `{ sessionCode, permissions }` | idem |
| `permission:revoke` | `{ sessionCode, permissions }` | idem |

### Client → Server (sem ack — fire-and-forget)

Erros aqui são apenas logados; não há resposta. São eventos de alta frequência
ou best-effort:

| Evento | `data` |
|---|---|
| `presence:update` | `{ sessionCode, cursorX?, cursorY?, route?, scrollX?, scrollY?, ... }` |
| `cobrowsing:event` | `{ sessionCode, type, payload? }` |
| `remote:command` | `{ sessionCode, type, targetSupportId?, route?, scroll*?, value?, at? }` |

### Server → Client

`support:bootstrap`, `agents:list`, `ticket:created`, `ticket:accepted`,
`session:approval_requested`, `session:active`, `session:finished`,
`participant:joined`, `participant:left`, `presence:updated`,
`cobrowsing:event_received`, `log:appended`, `permission:requested`,
`permission:granted`, `permission:revoked`, `permission:state`,
`remote:command_received`.

---

## Salas e roteamento

O isolamento entre atendimentos é feito por **salas** (rooms):

| Sala | Quem está nela | Para quê |
|---|---|---|
| `user:{userId}` | Todas as conexões de um mesmo usuário | Entregar mensagens direcionadas a uma pessoa, independentemente da aba. |
| `ctx:{contextCode}` | Todos os registrados de um contexto | Broadcast da lista de atendentes. |
| `session:{code}` | Participantes ativos da sessão | Retransmitir presença, eventos de co-browsing e mudanças de permissão. |

Eventos de co-browsing usam retransmissão **para a sala exceto o remetente**, de
modo que quem originou o evento não o recebe de volta.

---

## Persistência efêmera e limites

- **Histórico da sessão** é limitado em memória: no máximo 200 eventos de
  co-browsing e 200 logs por sessão, sempre com os mais recentes no topo.
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
| Aceite do ticket | 60 s | Ticket em `requested` vira `expired`. |
| Confirmação do usuário | 90 s | Ticket aceito e não confirmado vira `expired` (`approval_timeout`). |
| Sessão sem heartbeat | 2 min | Sessão ativa com participante desconectado é encerrada como `expired`. |
| Intervalo do sweeper | 15 s | Frequência com que sessões obsoletas são varridas. |

Enquanto a sessão está ativa, cada participante envia `session:heartbeat`
periodicamente. Se uma conexão cai, o participante é marcado como desconectado
(mas permanece na sessão); se não voltar a tempo, o sweeper encerra a sessão.

---

## Resiliência de conexão

- **Reconexão.** Ao registrar novamente, o servidor recoloca o socket nas salas
  das sessões ativas de que a pessoa participa, marca o participante como
  conectado e notifica os demais com `participant:joined`.
- **Queda de aba.** Enquanto restar ao menos uma conexão do usuário, ele
  continua online. Na queda da última, ele é marcado offline, a lista de
  atendentes é rebroadcast e as sessões ativas recebem `participant:left`.

---

## Códigos de erro

Retornados no ack (`error.code`) quando um evento com confirmação falha:

| Código | Significado |
|---|---|
| `NOT_REGISTERED` | Socket ainda não fez `support:register`. |
| `INVALID_PAYLOAD` | Campos obrigatórios ausentes ou permissão de sessão inválida. |
| `FORBIDDEN` | Ação não permitida para o papel/permissão do solicitante. |
| `AGENT_NOT_FOUND` | Atendente informado não existe ou não é atendente. |
| `TICKET_NOT_FOUND` | Ticket inexistente. |
| `SESSION_NOT_FOUND` | Sessão inexistente. |
| `INVALID_STATE` | Transição incompatível com o estado atual do ticket/sessão. |
| `ALREADY_HAS_OPEN_TICKET` | Usuário já tem um atendimento em andamento. |
| `INTERNAL_ERROR` | Falha não prevista. |
```