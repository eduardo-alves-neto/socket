import { EVENTS, PERMISSIONS, TTL } from "./events.js";
import {
  SupportError,
  appendCobrowsingEvent,
  appendLog,
  buildBootstrap,
  clearTimer,
  createParticipant,
  createTicketWithSession,
  isAgent,
  listAgents,
  now,
  sessions,
  setTimer,
  tickets,
  toAgent,
  upsertUser,
  users,
} from "./state.js";

const userRoom = (userId) => `user:${userId}`;
const sessionRoom = (code) => `session:${code}`;
const contextRoom = (contextCode) => `ctx:${contextCode}`;

// Envolve handler: extrai data do envelope, responde ack { ok, data?, error? }.
function withAck(socket, fn) {
  return async (envelope, ack) => {
    const respond = typeof ack === "function" ? ack : () => {};
    try {
      const data = await fn(envelope?.data ?? {}, envelope ?? {});
      respond({ ok: true, data });
    } catch (error) {
      const code = error instanceof SupportError ? error.code : "INTERNAL_ERROR";
      console.error(`[remote-support] ${socket.id} ${code}: ${error.message}`);
      respond({ ok: false, error: { code, message: error.message, detail: error.detail } });
    }
  };
}

function requireRegistered(socket) {
  const user = users.get(socket.data.userId);
  if (!user) throw new SupportError("NOT_REGISTERED", "Usuário não registrado no suporte remoto");
  return user;
}

function getSession(sessionCode) {
  const session = sessions.get(sessionCode);
  if (!session) throw new SupportError("SESSION_NOT_FOUND", "Sessão não encontrada");
  return session;
}

export function registerHandlers(nsp) {
  function broadcastAgents(contextCode) {
    nsp.to(contextRoom(contextCode)).emit(EVENTS.AGENTS_LIST, listAgents(contextCode));
  }

  function emitLog(session, entry) {
    const log = appendLog(session, entry);
    nsp.to(sessionRoom(session.code)).emit(EVENTS.LOG_APPENDED, log);
    return log;
  }

  function touch(...records) {
    const ts = now();
    for (const record of records) record.updatedAt = ts;
  }

  function finishSession(session, reason, actorId) {
    if (session.status === "finished") return;
    const ticket = tickets.get(session.ticketId);
    clearTimer(session.ticketId);

    session.status = reason === "expired" ? "expired" : "finished";
    session.finishedAt = now();
    session.finishReason = reason;
    if (ticket) {
      ticket.status = reason === "expired" ? "expired" : "finished";
      ticket.finishedAt = session.finishedAt;
      ticket.finishReason = reason;
      touch(ticket);
    }
    touch(session);

    emitLog(session, {
      actorId,
      type: "session_finished",
      message: `Atendimento encerrado (${reason})`,
    });

    const payload = { ticket, session };
    nsp.to(userRoom(session.requesterId)).emit(EVENTS.SESSION_FINISHED, payload);
    if (session.agentId) nsp.to(userRoom(session.agentId)).emit(EVENTS.SESSION_FINISHED, payload);
    nsp.socketsLeave(sessionRoom(session.code));
  }

  function rejectTicket(ticket, session, status, reason, actorId) {
    clearTimer(ticket.id);
    ticket.status = status;
    session.status = status === "expired" ? "expired" : "finished";
    session.finishedAt = now();
    session.finishReason = reason;
    touch(ticket, session);

    const payload = { ticket, session };
    nsp.to(userRoom(ticket.requesterId)).emit(EVENTS.SESSION_FINISHED, payload);
    if (ticket.agentId) nsp.to(userRoom(ticket.agentId)).emit(EVENTS.SESSION_FINISHED, payload);

    appendLog(session, {
      actorId,
      type: "ticket_closed",
      message: `Chamado encerrado (${reason})`,
    });
  }

  // Sweeper: encerra sessões ativas cujo participante está sem heartbeat/desconectado há muito tempo.
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - TTL.SESSION_STALE_MS;
    for (const session of sessions.values()) {
      if (session.status !== "active") continue;
      const stale = Object.values(session.participants).some(
        (p) => !p.connected && Date.parse(p.lastHeartbeatAt) < cutoff,
      );
      if (stale) finishSession(session, "expired");
    }
  }, TTL.SWEEP_INTERVAL_MS);
  sweeper.unref?.();

  nsp.on("connection", (socket) => {
    const contextCode =
      socket.handshake.auth?.ContextCode ?? socket.handshake.auth?.ContextGuid ?? "default";
    socket.data.contextCode = contextCode;

    socket.on(
      EVENTS.SUPPORT_REGISTER,
      withAck(socket, (data) => {
        if (!data.userId || !data.name)
          throw new SupportError("INVALID_PAYLOAD", "userId e name são obrigatórios");

        const user = upsertUser(data, contextCode, socket.id);
        socket.data.userId = user.id;
        socket.join(userRoom(user.id));
        socket.join(contextRoom(contextCode));

        // Reconecta em sessões ativas das quais participa.
        for (const session of sessions.values()) {
          const participant = session.participants[user.id];
          if (session.status !== "active" || !participant) continue;
          socket.join(sessionRoom(session.code));
          participant.connected = true;
          participant.lastHeartbeatAt = now();
          socket.to(sessionRoom(session.code)).emit(EVENTS.PARTICIPANT_JOINED, participant);
        }

        broadcastAgents(contextCode);
        return { user: toAgent(user), bootstrap: buildBootstrap(user) };
      }),
    );

    socket.on(
      EVENTS.SUPPORT_AGENTS_LIST,
      withAck(socket, () => {
        requireRegistered(socket);
        return { agents: listAgents(contextCode) };
      }),
    );

    socket.on(
      EVENTS.TICKET_CREATE,
      withAck(socket, (data) => {
        const requester = requireRegistered(socket);
        if (!requester.permissions.has(PERMISSIONS.REQUEST))
          throw new SupportError("FORBIDDEN", "Sem permissão para solicitar suporte");
        if (!data.agentId || !["assisted", "shared"].includes(data.mode))
          throw new SupportError("INVALID_PAYLOAD", "agentId e mode são obrigatórios");

        const agent = users.get(data.agentId);
        if (!agent || !isAgent(agent))
          throw new SupportError("AGENT_NOT_FOUND", "Atendente não encontrado");
        if (agent.id === requester.id)
          throw new SupportError("INVALID_PAYLOAD", "Não é possível solicitar suporte a si mesmo");

        const { ticket, session } = createTicketWithSession({
          requesterId: requester.id,
          agentId: agent.id,
          mode: data.mode,
          ttlMs: TTL.TICKET_MS,
        });

        appendLog(session, {
          actorId: requester.id,
          type: "ticket_created",
          message: `${requester.name} solicitou suporte (${data.mode})`,
        });

        nsp.to(userRoom(agent.id)).emit(EVENTS.TICKET_CREATED, { ticket, session });

        setTimer(
          ticket.id,
          () => {
            if (ticket.status === "requested" || ticket.status === "waiting_user_approval")
              rejectTicket(ticket, session, "expired", "expired");
          },
          TTL.TICKET_MS,
        );

        return { ticket, session };
      }),
    );

    socket.on(
      EVENTS.TICKET_ACCEPT,
      withAck(socket, (data) => {
        const agent = requireRegistered(socket);
        const ticket = tickets.get(data.ticketId);
        if (!ticket) throw new SupportError("TICKET_NOT_FOUND", "Chamado não encontrado");
        if (ticket.agentId !== agent.id)
          throw new SupportError("FORBIDDEN", "Chamado atribuído a outro atendente");
        if (ticket.status !== "requested")
          throw new SupportError("INVALID_STATE", `Chamado em estado inválido: ${ticket.status}`);

        const session = getSession(ticket.sessionCode);
        ticket.status = "waiting_user_approval";
        ticket.acceptedAt = now();
        ticket.approvalExpiresAt = new Date(Date.now() + TTL.APPROVAL_MS).toISOString();
        session.acceptedAt = ticket.acceptedAt;
        session.approvalExpiresAt = ticket.approvalExpiresAt;
        session.status = "waiting_user_approval";
        touch(ticket, session);

        appendLog(session, {
          actorId: agent.id,
          type: "ticket_accepted",
          message: `${agent.name} aceitou o chamado`,
        });

        const payload = { ticket, session };
        nsp.to(userRoom(ticket.requesterId)).emit(EVENTS.TICKET_ACCEPTED, payload);
        nsp.to(userRoom(agent.id)).emit(EVENTS.TICKET_ACCEPTED, payload);
        nsp.to(userRoom(ticket.requesterId)).emit(EVENTS.SESSION_APPROVAL_REQUESTED, payload);

        setTimer(
          ticket.id,
          () => {
            if (ticket.status === "waiting_user_approval")
              rejectTicket(ticket, session, "expired", "approval_timeout", agent.id);
          },
          TTL.APPROVAL_MS,
        );

        return payload;
      }),
    );

    socket.on(
      EVENTS.SESSION_CONFIRM,
      withAck(socket, async (data) => {
        const user = requireRegistered(socket);
        const session = getSession(data.sessionCode);
        const ticket = tickets.get(session.ticketId);
        if (!ticket) throw new SupportError("TICKET_NOT_FOUND", "Chamado não encontrado");
        if (session.requesterId !== user.id)
          throw new SupportError("FORBIDDEN", "Apenas o solicitante pode confirmar a sessão");
        if (ticket.status !== "waiting_user_approval")
          throw new SupportError("INVALID_STATE", `Chamado em estado inválido: ${ticket.status}`);

        clearTimer(ticket.id);

        if (!data.approved) {
          rejectTicket(ticket, session, "rejected", "rejected_by_user", user.id);
          return { ticket, session };
        }

        ticket.status = "active";
        session.status = "active";
        session.activeAt = now();
        session.participants[session.requesterId] = {
          ...createParticipant(session.requesterId, "requester"),
          ...session.participants[session.requesterId],
          connected: true,
        };
        session.participants[session.agentId] = createParticipant(session.agentId, "agent");
        touch(ticket, session);

        // Junta todos os sockets de ambos os usuários à sala da sessão.
        for (const userId of [session.requesterId, session.agentId]) {
          const memberSockets = await nsp.in(userRoom(userId)).fetchSockets();
          for (const memberSocket of memberSockets) memberSocket.join(sessionRoom(session.code));
        }

        const payload = { ticket, session };
        nsp.to(sessionRoom(session.code)).emit(EVENTS.SESSION_ACTIVE, payload);
        for (const participant of Object.values(session.participants)) {
          nsp.to(sessionRoom(session.code)).emit(EVENTS.PARTICIPANT_JOINED, participant);
        }

        emitLog(session, {
          actorId: user.id,
          type: "session_started",
          message: "Atendimento iniciado",
        });

        return payload;
      }),
    );

    socket.on(
      EVENTS.SESSION_FINISH,
      withAck(socket, (data) => {
        const user = requireRegistered(socket);
        const session = getSession(data.sessionCode);
        if (!session.participants[user.id])
          throw new SupportError("FORBIDDEN", "Usuário não participa desta sessão");
        finishSession(session, data.reason ?? "finished", user.id);
        return undefined;
      }),
    );

    socket.on(
      EVENTS.SESSION_HEARTBEAT,
      withAck(socket, (data) => {
        const user = requireRegistered(socket);
        const session = getSession(data.sessionCode);
        const participant = session.participants[user.id];
        if (participant) {
          participant.connected = true;
          participant.lastHeartbeatAt = now();
        }
        return undefined;
      }),
    );

    // Sem ack no frontend: erros apenas logados.
    socket.on(EVENTS.PRESENCE_UPDATE, (envelope) => {
      const userId = socket.data.userId;
      const data = envelope?.data;
      if (!userId || !data?.sessionCode) return;
      const session = sessions.get(data.sessionCode);
      if (!session || session.status !== "active" || !session.participants[userId]) return;

      const presence = { ...data, userId, updatedAt: now() };
      socket.to(sessionRoom(session.code)).emit(EVENTS.PRESENCE_UPDATED, presence);
    });

    socket.on(EVENTS.COBROWSING_EVENT, (envelope) => {
      const userId = socket.data.userId;
      const data = envelope?.data;
      if (!userId || !data?.sessionCode || !data?.type) return;
      const session = sessions.get(data.sessionCode);
      if (!session || session.status !== "active" || !session.participants[userId]) return;

      const event = appendCobrowsingEvent(session, {
        userId,
        type: data.type,
        payload: data.payload,
        operationTrace: envelope.operationTrace,
      });
      socket.to(sessionRoom(session.code)).emit(EVENTS.COBROWSING_EVENT_RECEIVED, event);

      // Eventos de alta frequência não viram log.
      if (data.type !== "scroll_changed" && data.type !== "pointer_moved") {
        emitLog(session, {
          actorId: userId,
          type: `cobrowsing_${data.type}`,
          message: `Evento ${data.type}`,
          data: data.payload,
        });
      }
    });

    socket.on("disconnect", () => {
      const userId = socket.data.userId;
      if (!userId) return;
      const user = users.get(userId);
      if (!user) return;

      user.sockets.delete(socket.id);
      if (user.sockets.size > 0) return;

      // Última conexão do usuário caiu: marca offline e avisa salas ativas.
      broadcastAgents(user.contextCode);
      for (const session of sessions.values()) {
        const participant = session.participants[userId];
        if (session.status !== "active" || !participant) continue;
        participant.connected = false;
        participant.leftAt = now();
        nsp.to(sessionRoom(session.code)).emit(EVENTS.PARTICIPANT_LEFT, { userId });
      }
    });
  });
}
