# Remote Support Socket.IO

Backend Go para suporte remoto via Socket.IO no namespace `/remote-support`.

## Estrutura

- `cmd/remote-support`: ponto de entrada do binario.
- `internal/app`: composicao do HTTP, Socket.IO, store e servico.
- `internal/domain`: modelos, erros e maquina de estados.
- `internal/store/memory`: repositorio em memoria protegido por `sync.RWMutex`.
- `internal/service`: regras de negocio, permissoes, TTLs e emissao de broadcasts por interface.
- `internal/transport/socketio`: adaptador Socket.IO, envelopes, acks, salas e broadcasts reais.

A regra de negocio nao importa Socket.IO diretamente. Essa separacao deixa os testes mais simples e permite trocar o transporte ou o repositorio depois.

## Como Rodar

```bash
go run ./cmd/remote-support
```

Por padrao:

- HTTP: `:8080`
- Namespace Socket.IO: `/remote-support`
- Engine.IO path: `/v1/remote-support/socket.io`

Exemplo de cliente:

```js
import { io } from "socket.io-client";

const socket = io("http://localhost:8080/remote-support", {
  path: "/v1/remote-support/socket.io",
  transports: ["websocket"],
});
```

## Como Testar

```bash
go test ./...
```

## Envelope e Ack

Todo evento de entrada usa:

```json
{
  "operationTrace": "trace-123",
  "data": {}
}
```

Ack de sucesso:

```json
{
  "ok": true,
  "data": {}
}
```

Ack de erro:

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_STATE",
    "message": "transicao de estado invalida",
    "detail": {}
  }
}
```

## Eventos Cliente Para Servidor

- `support:register`
- `support:agents:list`
- `ticket:create`
- `ticket:accept`
- `session:confirm`
- `session:finish`
- `session:heartbeat`
- `presence:update`
- `cobrowsing:event`

## Broadcasts Servidor Para Clientes

- `support:bootstrap`
- `ticket:created`
- `ticket:accepted`
- `session:approval_requested`
- `session:active`
- `session:finished`
- `participant:joined`
- `participant:left`
- `presence:updated`
- `cobrowsing:event_received`
- `log:appended`

Presenca, co-browsing e logs sao emitidos apenas para a sala `session:{sessionCode}`.

## Payloads Principais

`support:register`

```json
{
  "operationTrace": "trace-register",
  "data": {
    "userId": "user-1",
    "name": "Usuario",
    "roles": ["user"],
    "permissions": []
  }
}
```

`ticket:create`

```json
{
  "operationTrace": "trace-create",
  "data": {
    "agentId": "agent-1",
    "mode": "assisted"
  }
}
```

`ticket:accept`

```json
{
  "operationTrace": "trace-accept",
  "data": {
    "ticketId": "ticket-000001"
  }
}
```

`session:confirm`

```json
{
  "operationTrace": "trace-confirm",
  "data": {
    "sessionCode": "RS-000002",
    "approved": true
  }
}
```

`presence:update`

```json
{
  "operationTrace": "trace-presence",
  "data": {
    "sessionCode": "RS-000002",
    "route": "/audits/123",
    "cursorX": 10,
    "cursorY": 20,
    "scrollY": 300,
    "focusedElement": "#save"
  }
}
```

`cobrowsing:event`

```json
{
  "operationTrace": "trace-cursor",
  "data": {
    "sessionCode": "RS-000002",
    "type": "cursor",
    "payload": {
      "x": 10,
      "y": 20
    }
  }
}
```

## TTLs

- Ticket solicitado: 5 minutos.
- Confirmacao do usuario: 90 segundos.
- Sessao ativa sem usuario assistido presente: 2 minutos.
- Heartbeat esperado: 30 segundos, com tolerancia de 60 segundos.

Expiracoes de `requested` e `waiting_user_approval` viram `expired`. Sessao `active` sem usuario assistido e encerrada como `finished`, porque a maquina de estados valida do MVP permite `active -> finished`.
