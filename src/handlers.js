import { EVENTS, PERMISSIONS, TTL } from "./events.js";
import {
  SupportError,
  appendCobrowsingEvent,
  appendLog,
  buildBootstrap,
  clearTimer,
  createParticipant,
  createSessionWithTickets,
  isAgent,
  isOpenTicket,
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
    if (session.status === "finished" || session.status === "expired") return;

    const terminalStatus = reason === "expired" ? "expired" : "finished";

    // Encerra todos os tickets abertos desta sessão
    for (const ticket of tickets.values()) {
      if (ticket.sessionCode === session.code && isOpenTicket(ticket)) {
        clearTimer(ticket.id);
        ticket.status = terminalStatus;
        ticket.finishedAt = now();
        ticket.finishReason = reason;
        touch(ticket);
      }
    }

    session.status = terminalStatus;
    session.finishedAt = now();
    session.finishReason = reason;
    touch(session);

    emitLog(session, {
      actorId,
      type: "session_finished",
      message: `Atendimento encerrado (${reason})`,
    });

    const payload = { session };
    // Notifica via sala da sessão (participantes ativos) + diretamente ao solicitante e agentes
    nsp.to(sessionRoom(session.code)).emit(EVENTS.SESSION_FINISHED, payload);
    nsp.to(userRoom(session.requesterId)).emit(EVENTS.SESSION_FINISHED, payload);
    for (const [userId, p] of Object.entries(session.participants)) {
      if (p.role === "agent") nsp.to(userRoom(userId)).emit(EVENTS.SESSION_FINISHED, payload);
    }
    nsp.socketsLeave(sessionRoom(session.code));
  }

  function rejectTicket(ticket, session, status, reason, actorId) {
    clearTimer(ticket.id);
    ticket.status = status;
    ticket.finishedAt = now();
    ticket.finishReason = reason;
    touch(ticket);

    appendLog(session, {
      actorId,
      type: "ticket_closed",
      message: `Chamado encerrado (${reason})`,
    });

    // Verifica se há outros tickets ainda abertos nesta sessão
    const otherOpen = [...tickets.values()].some(
      (t) => t.id !== ticket.id && t.sessionCode === session.code && isOpenTicket(t),
    );

    // Notifica o agente deste ticket
    if (ticket.agentId) {
      nsp.to(userRoom(ticket.agentId)).emit(EVENTS.SESSION_FINISHED, { ticket, session });
    }

    // Só encerra a sessão quando não houver mais tickets abertos
    if (!otherOpen) {
      finishSession(session, reason, actorId);
    }
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

        const rawIds = Array.isArray(data.agentIds)
          ? data.agentIds
          : data.agentId
            ? [data.agentId]
            : [];
        if (!rawIds.length || !["assisted", "shared"].includes(data.mode))
          throw new SupportError("INVALID_PAYLOAD", "agentIds e mode são obrigatórios");

        const agentIds = [...new Set(rawIds)];
        const agentUsers = agentIds.map((id) => {
          const a = users.get(id);
          if (!a || !isAgent(a))
            throw new SupportError("AGENT_NOT_FOUND", `Atendente não encontrado: ${id}`);
          if (a.id === requester.id)
            throw new SupportError("INVALID_PAYLOAD", "Não é possível solicitar suporte a si mesmo");
          return a;
        });

        const existingBlocking = [...tickets.values()].find(
          (t) =>
            (t.status === "waiting_user_approval" || t.status === "active") &&
            t.requesterId === requester.id,
        );
        if (existingBlocking)
          throw new SupportError(
            "ALREADY_HAS_OPEN_TICKET",
            "Você já possui um atendimento em andamento",
          );

        const { session, tickets: createdTickets } = createSessionWithTickets({
          requesterId: requester.id,
          agentIds,
          mode: data.mode,
          ttlMs: TTL.TICKET_MS,
        });

        appendLog(session, {
          actorId: requester.id,
          type: "ticket_created",
          message: `${requester.name} solicitou suporte para ${agentUsers.length} atendente(s) (${data.mode})`,
        });

        for (let i = 0; i < agentUsers.length; i++) {
          const agentTicket = createdTickets[i];
          nsp.to(userRoom(agentUsers[i].id)).emit(EVENTS.TICKET_CREATED, { ticket: agentTicket, session });
          setTimer(
            agentTicket.id,
            () => {
              if (agentTicket.status === "requested")
                rejectTicket(agentTicket, session, "expired", "expired");
            },
            TTL.TICKET_MS,
          );
        }

        return { tickets: createdTickets, session };
      }),
    );

    socket.on(
      EVENTS.TICKET_ACCEPT,
      withAck(socket, async (data) => {
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
        touch(ticket);

        // Adiciona agente como participante da sessão compartilhada
        if (!session.participants[agent.id]) {
          session.participants[agent.id] = createParticipant(agent.id, "agent");
        }

        appendLog(session, {
          actorId: agent.id,
          type: "ticket_accepted",
          message: `${agent.name} aceitou o chamado`,
        });

        const payload = { ticket, session };
        nsp.to(userRoom(agent.id)).emit(EVENTS.TICKET_ACCEPTED, payload);

        if (session.status === "requested") {
          // Primeiro agente a aceitar: move sessão para waiting_user_approval
          session.status = "waiting_user_approval";
          session.acceptedAt = ticket.acceptedAt;
          session.approvalExpiresAt = ticket.approvalExpiresAt;
          session.primaryTicketId = ticket.id;
          touch(session);

          nsp.to(userRoom(ticket.requesterId)).emit(EVENTS.TICKET_ACCEPTED, payload);
          nsp.to(userRoom(ticket.requesterId)).emit(EVENTS.SESSION_APPROVAL_REQUESTED, payload);

          setTimer(
            ticket.id,
            () => {
              if (ticket.status === "waiting_user_approval")
                rejectTicket(ticket, session, "expired", "approval_timeout", agent.id);
            },
            TTL.APPROVAL_MS,
          );
        } else if (session.status === "waiting_user_approval") {
          // Agente adicional aceita enquanto aguarda aprovação
          touch(session);
          nsp.to(userRoom(ticket.requesterId)).emit(EVENTS.TICKET_ACCEPTED, payload);
        } else if (session.status === "active") {
          // Sessão já ativa: agente entra diretamente
          touch(session);
          const agentSockets = await nsp.in(userRoom(agent.id)).fetchSockets();
          for (const s of agentSockets) s.join(sessionRoom(session.code));
          nsp.to(sessionRoom(session.code)).emit(EVENTS.PARTICIPANT_JOINED, session.participants[agent.id]);
        }

        return payload;
      }),
    );

    socket.on(
      EVENTS.SESSION_CONFIRM,
      withAck(socket, async (data) => {
        const user = requireRegistered(socket);
        const session = getSession(data.sessionCode);
        if (session.requesterId !== user.id)
          throw new SupportError("FORBIDDEN", "Apenas o solicitante pode confirmar a sessão");
        if (session.status !== "waiting_user_approval")
          throw new SupportError("INVALID_STATE", `Sessão em estado inválido: ${session.status}`);

        const primaryTicket = tickets.get(session.primaryTicketId);
        if (!primaryTicket) throw new SupportError("TICKET_NOT_FOUND", "Chamado não encontrado");

        clearTimer(primaryTicket.id);

        if (!data.approved) {
          // Rejeita todos os tickets abertos desta sessão
          for (const t of tickets.values()) {
            if (t.sessionCode === session.code && isOpenTicket(t)) {
              clearTimer(t.id);
              t.status = "rejected";
              t.finishedAt = now();
              t.finishReason = "rejected_by_user";
              touch(t);
            }
          }
          session.status = "finished";
          session.finishedAt = now();
          session.finishReason = "rejected_by_user";
          touch(session);
          const rejPayload = { ticket: primaryTicket, session };
          nsp.to(userRoom(session.requesterId)).emit(EVENTS.SESSION_FINISHED, rejPayload);
          for (const [uid, p] of Object.entries(session.participants)) {
            if (p.role === "agent") nsp.to(userRoom(uid)).emit(EVENTS.SESSION_FINISHED, rejPayload);
          }
          return rejPayload;
        }

        // Ativa todos os tickets aceitos e marca os demais como expirados
        for (const t of tickets.values()) {
          if (t.sessionCode === session.code) {
            if (t.status === "waiting_user_approval") {
              clearTimer(t.id);
              t.status = "active";
              touch(t);
            } else if (t.status === "requested") {
              clearTimer(t.id);
              t.status = "expired";
              t.finishedAt = now();
              t.finishReason = "session_confirmed_without_response";
              touch(t);
            }
          }
        }

        session.status = "active";
        session.activeAt = now();
        session.participants[session.requesterId] = {
          ...createParticipant(session.requesterId, "requester"),
          ...session.participants[session.requesterId],
          connected: true,
        };
        // Garante que todos os agentes que aceitaram estão nos participants
        for (const [uid, p] of Object.entries(session.participants)) {
          if (p.role === "agent") {
            session.participants[uid] = { ...createParticipant(uid, "agent"), ...p };
          }
        }
        touch(session);

        // Junta todos os participantes à sala da sessão
        for (const userId of Object.keys(session.participants)) {
          const memberSockets = await nsp.in(userRoom(userId)).fetchSockets();
          for (const memberSocket of memberSockets) memberSocket.join(sessionRoom(session.code));
        }

        const payload = { ticket: primaryTicket, session };
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
          // Mensagem amigável é montada no frontend (tem contexto do DOM); fallback genérico.
          message: data.payload?.message ?? `Evento ${data.type}`,
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
