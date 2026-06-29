# Remote Support Server (Node + Socket.IO)

Servidor Socket.IO em memória para a feature `remote-support` do One (co-browsing por eventos, sem WebRTC).

## Rodando

```bash
npm install
npm start        # porta 8081 (PORT para mudar)
npm run dev      # com --watch
npm run smoke    # testa fluxo completo contra servidor rodando
```

Frontend já aponta por padrão para `http://localhost:8081` com namespace `/remote-support` e path `/v1/remote-support/socket.io` (vars `NEXT_PUBLIC_REMOTE_SUPPORT_SOCKET_URL` / `NEXT_PUBLIC_REMOTE_SUPPORT_SOCKET_PATH`).

## Protocolo

Entrada (todos eventos client→server): envelope `{ operationTrace: string, data?: T }`.
Ack: `{ ok: boolean, data?: T, error?: { code, message, detail? } }`.

### Client → Server (com ack)

| Evento | data | ack data |
|---|---|---|
| `support:register` | `{ userId, name, email?, avatar?, permissions? }` | `{ user, bootstrap }` |
| `support:agents:list` | — | `{ agents }` |
| `ticket:create` | `{ agentIds? / agentId?, mode: "assisted" / "shared", permissions? }` | `{ ticket, tickets, session }` |
| `ticket:accept` | `{ ticketId }` | `{ ticket, session }` |
| `session:confirm` | `{ sessionCode, approved }` | `{ ticket, session }` |
| `session:finish` | `{ sessionCode, reason }` | — |
| `session:heartbeat` | `{ sessionCode }` | — |
| `permission:request` | `{ sessionCode, permissions }` | `{ sessionCode, permissions, pendingPermissions }` |
| `permission:cancel` | `{ sessionCode, permissions }` | `{ sessionCode, permissions, pendingPermissions }` |
| `permission:grant` | `{ sessionCode, permissions }` | `{ sessionCode, permissions, pendingPermissions }` |
| `permission:revoke` | `{ sessionCode, permissions }` | `{ sessionCode, permissions, pendingPermissions }` |

### Client → Server (fire-and-forget)

| Evento | data |
|---|---|
| `presence:update` | `{ sessionCode, cursorX?, cursorY?, route?, scrollX?, scrollY?, ... }` |
| `cobrowsing:event` | `{ sessionCode, type, payload? }` |
| `remote:command` | `{ sessionCode, type, targetSupportId?, route?, scrollTarget?, scrollElementPath?, scrollRatioX?, scrollRatioY?, scrollX?, scrollY?, value?, issuedByParticipantId?, at? }` |

Para scroll de containers internos, `payload` de `cobrowsing:event` e `remote:command` aceitam os campos opcionais `scrollTarget: "window" | "element"`, `scrollElementPath`, `componentSupportId`, `scrollRatioX`, `scrollRatioY`, `scrollX` e `scrollY`.

### Server → Client

`agents:list`, `ticket:created`, `ticket:accepted`, `session:approval_requested`, `session:active`, `session:finished`, `participant:joined`, `participant:left`, `presence:updated`, `cobrowsing:event_received`, `log:appended`, `permission:requested`, `permission:granted`, `permission:revoked`, `permission:state`, `remote:command_received`.

## Fluxo

1. Usuário registra (`support:register`) com permissão `remote-support.request`; atendente registra com `remote-support.agent`.
2. Usuário lista atendentes e cria chamado (`ticket:create`) → atendente recebe `ticket:created`.
3. Atendente aceita (`ticket:accept`) → usuário recebe `session:approval_requested` (popup de confirmação).
4. Usuário confirma (`session:confirm` com `approved: true`) → ambos entram na sala `session:{code}` e recebem `session:active`.
5. Presence e eventos de co-browsing são retransmitidos só dentro da sala.
6. Atendente solicita permissões com `permission:request`; usuário concede/revoga com `permission:grant`/`permission:revoke`; servidor emite `permission:state` como fonte da verdade.
7. Com `ControlCoBrowsing` ativo, `remote:command` do atendente é entregue ao usuário como `remote:command_received`.
8. Qualquer participante encerra com `session:finish` → `session:finished` para todos.

## Regras

- Estado 100% em memória (reinício zera tudo).
- Permissões de usuário vêm do payload de registro; permissões de sessão aceitas são `ViewCoBrowsing`, `ControlCoBrowsing` e `ShowRemotePointer`.
- TTLs: ticket 5 min, aprovação 90 s, sessão com participante desconectado/sem heartbeat 2 min (sweeper a cada 15 s).
- `scroll_changed` e `pointer_moved` não geram log (alta frequência); demais eventos viram `log:appended`.
- Multi-tenant simples por `ContextCode` do handshake (`auth.ContextCode`): lista de atendentes é por contexto.
