// Smoke test: simula fluxo completo usuário + atendente contra o servidor local.
// Uso: inicie o servidor (npm start) e rode `npm run smoke`.
import { randomUUID } from "node:crypto";
import { io } from "socket.io-client";

const URL = process.env.URL ?? "http://localhost:8081";
const NAMESPACE = "/remote-support";
const PATH = "/v1/remote-support/socket.io";

function connect(name) {
  const socket = io(`${URL}${NAMESPACE}`, {
    path: PATH,
    transports: ["websocket"],
    auth: { token: "fake-token", ContextCode: "ctx-1", ContextGuid: "ctx-1" },
  });
  socket.onAny((event, ...args) => {
    console.log(`  [${name}] <- ${event}`, JSON.stringify(args[0])?.slice(0, 140) ?? "");
  });
  return socket;
}

function emit(socket, event, data) {
  return new Promise((resolve, reject) => {
    socket
      .timeout(5000)
      .emit(event, { operationTrace: randomUUID(), data }, (err, ack) => {
        if (err) return reject(err);
        if (!ack?.ok) return reject(new Error(`${event}: ${ack?.error?.code} ${ack?.error?.message}`));
        resolve(ack.data);
      });
  });
}

function waitFor(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout esperando ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

const fail = (msg) => {
  console.error(`FALHOU: ${msg}`);
  process.exit(1);
};
const assert = (cond, msg) => !cond && fail(msg);

const user = connect("user");
const agent = connect("agent");

try {
  console.log("1. registro");
  const userReg = await emit(user, "support:register", {
    userId: "user-1",
    name: "Usuário Teste",
    permissions: ["remote-support.request"],
  });
  assert(userReg.user.id === "user-1", "registro do usuário");

  const agentReg = await emit(agent, "support:register", {
    userId: "agent-1",
    name: "Suporte Teste",
    permissions: ["remote-support.agent"],
  });
  assert(agentReg.user.id === "agent-1", "registro do atendente");

  console.log("2. lista de atendentes");
  const { agents } = await emit(user, "support:agents:list");
  assert(agents.some((a) => a.id === "agent-1" && a.online), "atendente online na lista");

  console.log("3. criação do chamado");
  const ticketCreatedOnAgent = waitFor(agent, "ticket:created");
  const { ticket } = await emit(user, "ticket:create", { agentId: "agent-1", mode: "shared" });
  assert(ticket.status === "requested", "ticket requested");
  await ticketCreatedOnAgent;

  console.log("4. aceite pelo atendente");
  const approvalRequested = waitFor(user, "session:approval_requested");
  const accepted = await emit(agent, "ticket:accept", { ticketId: ticket.id });
  assert(accepted.ticket.status === "waiting_user_approval", "ticket waiting_user_approval");
  const approval = await approvalRequested;
  assert(approval.session.code === ticket.sessionCode, "approval traz sessionCode");

  console.log("5. confirmação pelo usuário");
  const sessionActiveOnAgent = waitFor(agent, "session:active");
  const confirmed = await emit(user, "session:confirm", {
    sessionCode: ticket.sessionCode,
    approved: true,
  });
  assert(confirmed.session.status === "active", "sessão ativa");
  assert(Object.keys(confirmed.session.participants).length === 2, "dois participantes");
  await sessionActiveOnAgent;

  console.log("6. presence + cobrowsing");
  const presenceOnAgent = waitFor(agent, "presence:updated");
  user.emit("presence:update", {
    operationTrace: randomUUID(),
    data: { sessionCode: ticket.sessionCode, cursorX: 0.5, cursorY: 0.3, route: "/home" },
  });
  const presence = await presenceOnAgent;
  assert(presence.userId === "user-1" && presence.cursorX === 0.5, "presence retransmitida");

  const eventOnAgent = waitFor(agent, "cobrowsing:event_received");
  user.emit("cobrowsing:event", {
    operationTrace: randomUUID(),
    data: { sessionCode: ticket.sessionCode, type: "click", payload: { x: 10, y: 20 } },
  });
  const cbEvent = await eventOnAgent;
  assert(cbEvent.type === "click", "cobrowsing retransmitido");

  console.log("6b. cobrowsing route_changed (base do seguimento de rota do agente)");
  const routeEventOnAgent = waitFor(agent, "cobrowsing:event_received");
  user.emit("cobrowsing:event", {
    operationTrace: randomUUID(),
    data: {
      sessionCode: ticket.sessionCode,
      type: "route_changed",
      payload: { route: "/clientes", message: "Navegou para /clientes" },
    },
  });
  const routeEvent = await routeEventOnAgent;
  assert(routeEvent.type === "route_changed", "route_changed retransmitido");
  assert(routeEvent.payload?.route === "/clientes", "rota preservada no payload");
  assert(routeEvent.userId === "user-1", "userId do emissor preservado");
  assert(typeof routeEvent.id === "string", "evento tem id gerado");
  assert(typeof routeEvent.createdAt === "string", "evento tem createdAt");

  console.log("6c. cobrowsing scroll_changed (sem rota — não dispara navegação)");
  const scrollEventOnAgent = waitFor(agent, "cobrowsing:event_received");
  user.emit("cobrowsing:event", {
    operationTrace: randomUUID(),
    data: {
      sessionCode: ticket.sessionCode,
      type: "scroll_changed",
      payload: { scrollX: 0, scrollY: 300, message: "Rolagem" },
    },
  });
  const scrollEvent = await scrollEventOnAgent;
  assert(scrollEvent.type === "scroll_changed", "scroll_changed retransmitido");
  assert(scrollEvent.payload?.scrollY === 300, "scrollY preservado");
  assert(scrollEvent.payload?.route === undefined, "scroll_changed não carrega rota");

  console.log("7. permissões granulares");
  const permissionRequestedOnUser = waitFor(user, "permission:requested");
  const permissionStateOnAgent = waitFor(agent, "permission:state");
  const requestedState = await emit(agent, "permission:request", {
    sessionCode: ticket.sessionCode,
    permissions: ["ControlCoBrowsing"],
  });
  assert(requestedState.pendingPermissions.includes("ControlCoBrowsing"), "permissão pendente");
  const requested = await permissionRequestedOnUser;
  assert(requested.permissions.includes("ControlCoBrowsing"), "request recebido pelo usuário");
  await permissionStateOnAgent;

  const permissionGrantedOnAgent = waitFor(agent, "permission:granted");
  const grantedState = await emit(user, "permission:grant", {
    sessionCode: ticket.sessionCode,
    permissions: ["ControlCoBrowsing", "ViewCoBrowsing"],
  });
  assert(grantedState.permissions.includes("ControlCoBrowsing"), "controle concedido");
  assert(grantedState.permissions.includes("ViewCoBrowsing"), "visualização auto-concedida");
  const granted = await permissionGrantedOnAgent;
  assert(granted.permissions.includes("ControlCoBrowsing"), "grant recebido pelo atendente");

  console.log("8. comando remoto");
  const remoteCommandOnUser = waitFor(user, "remote:command_received");
  agent.emit("remote:command", {
    operationTrace: randomUUID(),
    data: {
      sessionCode: ticket.sessionCode,
      type: "remote.click",
      targetSupportId: "button-save",
      issuedByParticipantId: "agent-1",
      at: Date.now(),
    },
  });
  const command = await remoteCommandOnUser;
  assert(command.type === "remote.click", "comando remoto retransmitido");
  assert(command.issuedByParticipantId === "agent-1", "origem do comando preservada");

  console.log("9. revogação de permissões");
  const permissionRevokedOnAgent = waitFor(agent, "permission:revoked");
  const revokedState = await emit(user, "permission:revoke", {
    sessionCode: ticket.sessionCode,
    permissions: ["ViewCoBrowsing"],
  });
  assert(!revokedState.permissions.includes("ControlCoBrowsing"), "controle revogado em cascata");
  await permissionRevokedOnAgent;

  console.log("10. heartbeat");
  await emit(user, "session:heartbeat", { sessionCode: ticket.sessionCode });

  console.log("11. encerramento");
  const finishedOnUser = waitFor(user, "session:finished");
  await emit(agent, "session:finish", {
    sessionCode: ticket.sessionCode,
    reason: "support_agent_finished",
  });
  await finishedOnUser;

  console.log("\nSMOKE OK — fluxo completo funcionou.");
  process.exit(0);
} catch (error) {
  fail(error.message);
} finally {
  user.close();
  agent.close();
}
