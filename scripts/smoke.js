// Smoke test: simula o fluxo completo de lobby multi-atendente contra o servidor local.
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
const agentB = connect("agentB");
const agentC = connect("agentC");
const agentD = connect("agentD");

try {
  console.log("1. registro");
  const userReg = await emit(user, "support:register", {
    userId: "user-1",
    name: "Usuário Teste",
    permissions: ["remote-support.request"],
  });
  assert(userReg.user.id === "user-1", "registro do usuário");

  for (const [socket, id, name] of [
    [agentB, "agent-b", "Atendente B"],
    [agentC, "agent-c", "Atendente C"],
    [agentD, "agent-d", "Atendente D"],
  ]) {
    const reg = await emit(socket, "support:register", { userId: id, name, permissions: ["remote-support.agent"] });
    assert(reg.user.id === id, `registro de ${id}`);
  }

  console.log("2. lista de atendentes");
  const { agents } = await emit(user, "support:agents:list");
  assert(["agent-b", "agent-c"].every((id) => agents.some((a) => a.id === id && a.online)), "atendentes online na lista");

  console.log("3. criação da sala + convites para B e C");
  const inviteReceivedB = waitFor(agentB, "invite:received");
  const inviteReceivedC = waitFor(agentC, "invite:received");
  const { room, invites } = await emit(user, "room:create", {
    agentIds: ["agent-b", "agent-c"],
    mode: "shared",
  });
  assert(room.status === "open", "sala aberta imediatamente");
  assert(room.ownerId === "user-1", "dono da sala é o usuário");
  assert(invites.length === 2, "dois convites criados");
  assert(invites.every((i) => i.status === "pending"), "convites pendentes");
  await inviteReceivedB;
  await inviteReceivedC;

  console.log("4. B recusa o convite");
  const inviteUpdatedOnUserB = waitFor(user, "invite:updated");
  const inviteB = invites.find((i) => i.agentId === "agent-b");
  const declined = await emit(agentB, "invite:decline", { inviteId: inviteB.id });
  assert(declined.invite.status === "declined", "convite de B recusado");
  const declinedNotice = await inviteUpdatedOnUserB;
  assert(declinedNotice.invite.status === "declined", "usuário notificado da recusa");

  console.log("5. C aceita, dono aprova");
  const ownerApprovalRequested = waitFor(user, "owner:approval_requested");
  const inviteC = invites.find((i) => i.agentId === "agent-c");
  const acceptedC = await emit(agentC, "invite:accept", { inviteId: inviteC.id });
  assert(acceptedC.invite.status === "awaiting_owner_approval", "convite de C aguardando aprovação");
  const approvalReq = await ownerApprovalRequested;
  assert(approvalReq.invite.id === inviteC.id, "aprovação referencia o convite de C");

  const participantJoinedOnC = waitFor(agentC, "participant:joined");
  const approvedC = await emit(user, "invite:approve", { inviteId: inviteC.id, approved: true });
  assert(approvedC.invite.status === "joined", "C entrou na sala");
  assert(Object.keys(approvedC.room.participants).length === 2, "dois participantes (user + C)");
  await participantJoinedOnC;

  console.log("5b. presence + cobrowsing dentro da sala");
  const presenceOnC = waitFor(agentC, "presence:updated");
  user.emit("presence:update", {
    operationTrace: randomUUID(),
    data: { roomCode: room.code, cursorX: 0.5, cursorY: 0.3, route: "/home" },
  });
  const presence = await presenceOnC;
  assert(presence.userId === "user-1" && presence.cursorX === 0.5, "presence retransmitida");

  const eventOnC = waitFor(agentC, "cobrowsing:event_received");
  user.emit("cobrowsing:event", {
    operationTrace: randomUUID(),
    data: { roomCode: room.code, type: "click", payload: { x: 10, y: 20 } },
  });
  const cbEvent = await eventOnC;
  assert(cbEvent.type === "click", "cobrowsing retransmitido");

  console.log("6. sala ativa aceita convite dinâmico (D) mesmo já com C dentro");
  const inviteReceivedD = waitFor(agentD, "invite:received");
  const { invites: invitesRound2 } = await emit(user, "room:invite", { roomCode: room.code, agentIds: ["agent-d"] });
  assert(invitesRound2.length === 1, "convite dinâmico criado para D");
  await inviteReceivedD;

  const ownerApprovalRequestedD = waitFor(user, "owner:approval_requested");
  const inviteD = invitesRound2[0];
  await emit(agentD, "invite:accept", { inviteId: inviteD.id });
  await ownerApprovalRequestedD;
  const participantJoinedOnD = waitFor(agentC, "participant:joined");
  const approvedD = await emit(user, "invite:approve", { inviteId: inviteD.id, approved: true });
  assert(Object.keys(approvedD.room.participants).length === 3, "três participantes (user + C + D)");
  await participantJoinedOnD;

  console.log("7. permissões granulares");
  const permissionGrantedOnC = waitFor(agentC, "permission:granted");
  const grantedState = await emit(user, "permission:grant", {
    roomCode: room.code,
    permissions: ["ControlCoBrowsing"],
  });
  assert(grantedState.permissions.includes("ControlCoBrowsing"), "controle concedido");
  await permissionGrantedOnC;

  console.log("8. piloto único: C assume, D não consegue mandar comando, C libera, D assume");
  const driverChangedToC = waitFor(agentD, "driver:changed");
  const claimC = await emit(agentC, "driver:claim", { roomCode: room.code });
  assert(claimC.driverId === "agent-c", "C é o piloto");
  await driverChangedToC;

  const remoteCommandOnUser = waitFor(user, "remote:command_received");
  agentC.emit("remote:command", {
    operationTrace: randomUUID(),
    data: { roomCode: room.code, type: "remote.click", targetSupportId: "btn-1", issuedByParticipantId: "agent-c", at: Date.now() },
  });
  const command = await remoteCommandOnUser;
  assert(command.issuedByParticipantId === "agent-c", "comando do piloto chega ao usuário");

  let dBlocked = true;
  user.once("remote:command_received", () => {
    dBlocked = false;
  });
  agentD.emit("remote:command", {
    operationTrace: randomUUID(),
    data: { roomCode: room.code, type: "remote.click", targetSupportId: "btn-2", issuedByParticipantId: "agent-d", at: Date.now() },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert(dBlocked, "D não é piloto — comando descartado silenciosamente");

  const driverChangedToNull = waitFor(agentD, "driver:changed");
  const releaseC = await emit(agentC, "driver:release", { roomCode: room.code });
  assert(releaseC.driverId === null, "C liberou o controle");
  await driverChangedToNull;

  const claimD = await emit(agentD, "driver:claim", { roomCode: room.code });
  assert(claimD.driverId === "agent-d", "D assume o controle após C liberar");

  console.log("8b. revogar ControlCoBrowsing derruba o piloto atual (D)");
  const driverChangedToNullOnRevoke = waitFor(agentD, "driver:changed");
  const revokedState = await emit(user, "permission:revoke", {
    roomCode: room.code,
    permissions: ["ControlCoBrowsing"],
  });
  assert(!revokedState.permissions.includes("ControlCoBrowsing"), "controle revogado");
  const revokeNotice = await driverChangedToNullOnRevoke;
  assert(revokeNotice.driverId === null, "piloto liberado ao revogar permissão");

  console.log("9. C sai da sala — sala continua para user e D");
  const participantLeftOnD = waitFor(agentD, "participant:left");
  await emit(agentC, "room:leave", { roomCode: room.code });
  const leftNotice = await participantLeftOnD;
  assert(leftNotice.userId === "agent-c", "notificação de saída de C");

  console.log("10. heartbeat");
  await emit(user, "room:heartbeat", { roomCode: room.code });

  console.log("11. dono encerra a sala — todos recebem room:closed");
  const roomClosedOnD = waitFor(agentD, "room:closed");
  await emit(user, "room:close", { roomCode: room.code });
  const closedPayload = await roomClosedOnD;
  assert(closedPayload.room.status === "closed", "sala encerrada");

  console.log("\nSMOKE OK — fluxo completo de lobby multi-atendente funcionou.");
  process.exit(0);
} catch (error) {
  fail(error.message);
} finally {
  user.close();
  agentB.close();
  agentC.close();
  agentD.close();
}
