import { EVENTS, PERMISSIONS, TTL } from "./events.js";
import {
  SupportError,
  applyGrant,
  applyRevoke,
  appendCobrowsingEvent,
  appendLog,
  buildBootstrap,
  clearDriver,
  clearTimer,
  createInvite,
  createRoom,
  invites,
  isAgent,
  isOpenInvite,
  joinParticipant,
  leaveParticipant,
  listAgents,
  normalizeSessionPermissions,
  now,
  rooms,
  setDriver,
  setTimer,
  toAgent,
  touch,
  upsertUser,
  users,
} from "./state.js";

const userRoom = (userId) => `user:${userId}`;
const roomRoom = (code) => `room:${code}`;
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

function getRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) throw new SupportError("ROOM_NOT_FOUND", "Sala não encontrada");
  return room;
}

function getInvite(inviteId) {
  const invite = invites.get(inviteId);
  if (!invite) throw new SupportError("INVITE_NOT_FOUND", "Convite não encontrado");
  return invite;
}

function parseSessionPermissions(value) {
  if (!Array.isArray(value)) return [];
  const permissions = normalizeSessionPermissions(value);
  if (permissions.length !== value.length) {
    throw new SupportError("INVALID_PAYLOAD", "Permissão de sessão inválida");
  }
  return permissions;
}

function requireOpenRoomParticipant(socket, roomCode) {
  const user = requireRegistered(socket);
  const room = getRoom(roomCode);
  if (room.status !== "open")
    throw new SupportError("INVALID_STATE", `Sala em estado inválido: ${room.status}`);
  const participant = room.participants[user.id];
  if (!participant) throw new SupportError("FORBIDDEN", "Usuário não participa desta sala");
  return { user, room, participant };
}

function resolveAgents(rawIds, requester) {
  const agentIds = [...new Set(rawIds)];
  if (!agentIds.length) throw new SupportError("INVALID_PAYLOAD", "agentIds é obrigatório");
  return agentIds.map((id) => {
    const a = users.get(id);
    if (!a || !isAgent(a))
      throw new SupportError("AGENT_NOT_FOUND", `Atendente não encontrado: ${id}`);
    if (a.id === requester.id)
      throw new SupportError("INVALID_PAYLOAD", "Não é possível convidar a si mesmo");
    return a;
  });
}

export function registerHandlers(nsp) {
  function broadcastAgents(contextCode) {
    nsp.to(contextRoom(contextCode)).emit(EVENTS.AGENTS_LIST, listAgents(contextCode));
  }

  function emitLog(room, entry) {
    const log = appendLog(room, entry);
    nsp.to(roomRoom(room.code)).emit(EVENTS.LOG_APPENDED, log);
    return log;
  }

  function permissionState(room) {
    return {
      roomCode: room.code,
      permissions: room.permissions ?? [],
      pendingPermissions: room.pendingPermissions ?? [],
    };
  }

  function emitPermissionState(room) {
    nsp.to(roomRoom(room.code)).emit(EVENTS.PERMISSION_STATE, permissionState(room));
  }

  function cancelOpenInvitesForRoom(room, reason, actorId) {
    for (const invite of invites.values()) {
      if (invite.roomCode !== room.code || !isOpenInvite(invite)) continue;
      clearTimer(invite.id);
      invite.status = "cancelled";
      invite.finishedAt = now();
      invite.finishReason = reason;
      touch(invite);
      nsp.to(userRoom(invite.agentId)).emit(EVENTS.INVITE_UPDATED, { invite });
    }
  }

  function closeRoom(room, reason, actorId) {
    if (room.status !== "open") return;

    room.status = reason === "expired" ? "expired" : "closed";
    room.closedAt = now();
    room.closeReason = reason;
    touch(room);

    cancelOpenInvitesForRoom(room, reason === "expired" ? "room_expired" : "room_closed", actorId);

    emitLog(room, {
      actorId,
      type: "room_closed",
      message: `Sala encerrada (${reason})`,
    });

    const payload = { room };
    nsp.to(roomRoom(room.code)).emit(EVENTS.ROOM_CLOSED, payload);
    for (const userId of Object.keys(room.participants)) {
      nsp.to(userRoom(userId)).emit(EVENTS.ROOM_CLOSED, payload);
    }
    nsp.socketsLeave(roomRoom(room.code));
  }

  // Sweeper: fecha salas cujo DONO está sem heartbeat/desconectado há muito tempo.
  // Atendentes desconectados não derrubam a sala — só ficam marcados como offline.
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - TTL.ROOM_STALE_MS;
    for (const room of rooms.values()) {
      if (room.status !== "open") continue;
      const owner = room.participants[room.ownerId];
      const stale = !owner || (!owner.connected && Date.parse(owner.lastHeartbeatAt) < cutoff);
      if (stale) closeRoom(room, "expired", room.ownerId);
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

        // Reconecta em salas abertas das quais participa.
        for (const room of rooms.values()) {
          const participant = room.participants[user.id];
          if (room.status !== "open" || !participant) continue;
          socket.join(roomRoom(room.code));
          participant.connected = true;
          participant.lastHeartbeatAt = now();
          socket.to(roomRoom(room.code)).emit(EVENTS.PARTICIPANT_JOINED, participant);
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
      EVENTS.ROOM_CREATE,
      withAck(socket, async (data) => {
        const requester = requireRegistered(socket);
        if (!requester.permissions.has(PERMISSIONS.REQUEST))
          throw new SupportError("FORBIDDEN", "Sem permissão para solicitar suporte");
        if (!["assisted", "shared"].includes(data.mode))
          throw new SupportError("INVALID_PAYLOAD", "mode é obrigatório");

        const alreadyOwnsRoom = [...rooms.values()].some(
          (r) => r.status === "open" && r.ownerId === requester.id,
        );
        if (alreadyOwnsRoom)
          throw new SupportError("ALREADY_HAS_OPEN_ROOM", "Você já possui uma sala aberta");

        const rawIds = Array.isArray(data.agentIds) ? data.agentIds : [];
        const agentUsers = resolveAgents(rawIds, requester);

        const room = createRoom({
          ownerId: requester.id,
          mode: data.mode,
          permissions: parseSessionPermissions(data.permissions),
        });
        const ownerSockets = await nsp.in(userRoom(requester.id)).fetchSockets();
        for (const s of ownerSockets) s.join(roomRoom(room.code));

        const createdInvites = agentUsers.map((agentUser) => {
          const invite = createInvite({
            roomCode: room.code,
            requesterId: requester.id,
            agentId: agentUser.id,
            mode: data.mode,
            ttlMs: TTL.INVITE_MS,
          });
          nsp.to(userRoom(agentUser.id)).emit(EVENTS.INVITE_RECEIVED, { invite, room });
          setTimer(
            invite.id,
            () => {
              if (invite.status === "pending") {
                clearTimer(invite.id);
                invite.status = "expired";
                invite.finishedAt = now();
                invite.finishReason = "expired";
                touch(invite);
                nsp.to(userRoom(invite.agentId)).emit(EVENTS.INVITE_UPDATED, { invite });
                nsp.to(userRoom(room.ownerId)).emit(EVENTS.INVITE_UPDATED, { invite });
              }
            },
            TTL.INVITE_MS,
          );
          return invite;
        });

        emitLog(room, {
          actorId: requester.id,
          type: "room_created",
          message: `${requester.name} criou a sala e convidou ${agentUsers.length} atendente(s) (${data.mode})`,
        });

        return { room, invites: createdInvites };
      }),
    );

    socket.on(
      EVENTS.ROOM_INVITE,
      withAck(socket, (data) => {
        const requester = requireRegistered(socket);
        const room = getRoom(data.roomCode);
        if (room.status !== "open")
          throw new SupportError("INVALID_STATE", `Sala em estado inválido: ${room.status}`);
        if (room.ownerId !== requester.id)
          throw new SupportError("FORBIDDEN", "Apenas o dono da sala pode convidar atendentes");

        const rawIds = Array.isArray(data.agentIds) ? data.agentIds : [];
        const agentUsers = resolveAgents(rawIds, requester);

        const existingOpenAgentIds = new Set(
          [...invites.values()]
            .filter((i) => i.roomCode === room.code && isOpenInvite(i))
            .map((i) => i.agentId),
        );

        const createdInvites = agentUsers
          .filter((agentUser) => {
            if (room.participants[agentUser.id]) return false;
            if (existingOpenAgentIds.has(agentUser.id)) return false;
            return true;
          })
          .map((agentUser) => {
            const invite = createInvite({
              roomCode: room.code,
              requesterId: requester.id,
              agentId: agentUser.id,
              mode: room.mode,
              ttlMs: TTL.INVITE_MS,
            });
            nsp.to(userRoom(agentUser.id)).emit(EVENTS.INVITE_RECEIVED, { invite, room });
            setTimer(
              invite.id,
              () => {
                if (invite.status === "pending") {
                  clearTimer(invite.id);
                  invite.status = "expired";
                  invite.finishedAt = now();
                  invite.finishReason = "expired";
                  touch(invite);
                  nsp.to(userRoom(invite.agentId)).emit(EVENTS.INVITE_UPDATED, { invite });
                  nsp.to(userRoom(room.ownerId)).emit(EVENTS.INVITE_UPDATED, { invite });
                }
              },
              TTL.INVITE_MS,
            );
            return invite;
          });

        emitLog(room, {
          actorId: requester.id,
          type: "room_invited",
          message: `${requester.name} convidou ${createdInvites.length} atendente(s) adicional(is)`,
        });

        return { room, invites: createdInvites };
      }),
    );

    socket.on(
      EVENTS.INVITE_ACCEPT,
      withAck(socket, (data) => {
        const agent = requireRegistered(socket);
        const invite = getInvite(data.inviteId);
        if (invite.agentId !== agent.id)
          throw new SupportError("FORBIDDEN", "Convite atribuído a outro atendente");
        if (invite.status !== "pending")
          throw new SupportError("INVALID_STATE", `Convite em estado inválido: ${invite.status}`);

        const room = getRoom(invite.roomCode);
        if (room.status !== "open")
          throw new SupportError("INVALID_STATE", `Sala em estado inválido: ${room.status}`);

        clearTimer(invite.id);
        invite.status = "awaiting_owner_approval";
        invite.acceptedAt = now();
        invite.approvalExpiresAt = new Date(Date.now() + TTL.APPROVAL_MS).toISOString();
        touch(invite);

        setTimer(
          invite.id,
          () => {
            if (invite.status === "awaiting_owner_approval") {
              clearTimer(invite.id);
              invite.status = "expired";
              invite.finishedAt = now();
              invite.finishReason = "approval_timeout";
              touch(invite);
              nsp.to(userRoom(invite.agentId)).emit(EVENTS.INVITE_UPDATED, { invite });
              nsp.to(userRoom(room.ownerId)).emit(EVENTS.INVITE_UPDATED, { invite });
            }
          },
          TTL.APPROVAL_MS,
        );

        emitLog(room, {
          actorId: agent.id,
          type: "invite_accepted",
          message: `${agent.name} aceitou o convite`,
        });

        const payload = { invite, room };
        nsp.to(userRoom(agent.id)).emit(EVENTS.INVITE_UPDATED, payload);
        nsp.to(userRoom(room.ownerId)).emit(EVENTS.INVITE_UPDATED, payload);
        nsp.to(userRoom(room.ownerId)).emit(EVENTS.OWNER_APPROVAL_REQUESTED, payload);

        return payload;
      }),
    );

    socket.on(
      EVENTS.INVITE_DECLINE,
      withAck(socket, (data) => {
        const agent = requireRegistered(socket);
        const invite = getInvite(data.inviteId);
        if (invite.agentId !== agent.id)
          throw new SupportError("FORBIDDEN", "Convite atribuído a outro atendente");
        if (!isOpenInvite(invite))
          throw new SupportError("INVALID_STATE", `Convite em estado inválido: ${invite.status}`);

        clearTimer(invite.id);
        invite.status = "declined";
        invite.finishedAt = now();
        invite.finishReason = "declined_by_agent";
        touch(invite);

        const room = rooms.get(invite.roomCode);
        if (room) {
          emitLog(room, {
            actorId: agent.id,
            type: "invite_declined",
            message: `${agent.name} recusou o convite`,
          });
          nsp.to(userRoom(room.ownerId)).emit(EVENTS.INVITE_UPDATED, { invite });
        }

        return { invite };
      }),
    );

    socket.on(
      EVENTS.INVITE_CANCEL,
      withAck(socket, (data) => {
        const requester = requireRegistered(socket);
        const invite = getInvite(data.inviteId);
        if (invite.requesterId !== requester.id)
          throw new SupportError("FORBIDDEN", "Apenas o dono da sala pode cancelar o convite");
        if (!isOpenInvite(invite))
          throw new SupportError("INVALID_STATE", `Convite em estado inválido: ${invite.status}`);

        clearTimer(invite.id);
        invite.status = "cancelled";
        invite.finishedAt = now();
        invite.finishReason = "cancelled_by_owner";
        touch(invite);

        nsp.to(userRoom(invite.agentId)).emit(EVENTS.INVITE_UPDATED, { invite });
        return { invite };
      }),
    );

    socket.on(
      EVENTS.INVITE_APPROVE,
      withAck(socket, async (data) => {
        const owner = requireRegistered(socket);
        const invite = getInvite(data.inviteId);
        if (invite.requesterId !== owner.id)
          throw new SupportError("FORBIDDEN", "Apenas o dono da sala pode aprovar o convite");
        if (invite.status !== "awaiting_owner_approval")
          throw new SupportError("INVALID_STATE", `Convite em estado inválido: ${invite.status}`);

        const room = getRoom(invite.roomCode);
        clearTimer(invite.id);

        if (!data.approved) {
          invite.status = "denied";
          invite.finishedAt = now();
          invite.finishReason = "denied_by_owner";
          touch(invite);

          const payload = { invite, room };
          nsp.to(userRoom(invite.agentId)).emit(EVENTS.INVITE_UPDATED, payload);
          return payload;
        }

        invite.status = "joined";
        touch(invite);

        joinParticipant(room, invite.agentId, "agent");
        const agentSockets = await nsp.in(userRoom(invite.agentId)).fetchSockets();
        for (const s of agentSockets) s.join(roomRoom(room.code));

        emitLog(room, {
          actorId: owner.id,
          type: "participant_joined",
          message: `${invite.agentId} entrou na sala`,
        });

        const payload = { invite, room };
        nsp.to(userRoom(invite.agentId)).emit(EVENTS.INVITE_UPDATED, payload);
        nsp.to(roomRoom(room.code)).emit(EVENTS.PARTICIPANT_JOINED, room.participants[invite.agentId]);

        return payload;
      }),
    );

    socket.on(
      EVENTS.ROOM_LEAVE,
      withAck(socket, async (data) => {
        const { user, room } = requireOpenRoomParticipant(socket, data.roomCode);

        if (room.ownerId === user.id) {
          closeRoom(room, "closed", user.id);
          return undefined;
        }

        leaveParticipant(room, user.id);

        // Marca o convite correspondente (já "joined") como encerrado.
        for (const invite of invites.values()) {
          if (invite.roomCode === room.code && invite.agentId === user.id && invite.status === "joined") {
            invite.status = "left";
            invite.finishedAt = now();
            invite.finishReason = "left_by_agent";
            touch(invite);
          }
        }

        emitLog(room, {
          actorId: user.id,
          type: "participant_left",
          message: `${user.name} saiu da sala`,
        });

        nsp.to(roomRoom(room.code)).emit(EVENTS.PARTICIPANT_LEFT, { userId: user.id });
        nsp.to(roomRoom(room.code)).emit(EVENTS.DRIVER_CHANGED, { roomCode: room.code, driverId: room.driverId });

        const memberSockets = await nsp.in(userRoom(user.id)).fetchSockets();
        for (const memberSocket of memberSockets) memberSocket.leave(roomRoom(room.code));

        return undefined;
      }),
    );

    socket.on(
      EVENTS.ROOM_CLOSE,
      withAck(socket, (data) => {
        const user = requireRegistered(socket);
        const room = getRoom(data.roomCode);
        if (room.ownerId !== user.id)
          throw new SupportError("FORBIDDEN", "Apenas o dono da sala pode encerrá-la");
        closeRoom(room, "closed", user.id);
        return undefined;
      }),
    );

    socket.on(
      EVENTS.ROOM_HEARTBEAT,
      withAck(socket, (data) => {
        const user = requireRegistered(socket);
        const room = rooms.get(data.roomCode);
        const participant = room?.participants[user.id];
        if (participant) {
          participant.connected = true;
          participant.lastHeartbeatAt = now();
        }
        return undefined;
      }),
    );

    socket.on(
      EVENTS.DRIVER_CLAIM,
      withAck(socket, (data) => {
        const { user, room, participant } = requireOpenRoomParticipant(socket, data.roomCode);
        if (participant.role !== "agent")
          throw new SupportError("FORBIDDEN", "Apenas atendentes podem assumir o controle");
        if (!(room.permissions ?? []).includes("ControlCoBrowsing"))
          throw new SupportError("FORBIDDEN", "Permissão de controle não concedida");
        if (room.driverId && room.driverId !== user.id)
          throw new SupportError("DRIVER_BUSY", "Outro atendente já está no controle");

        setDriver(room, user.id);
        nsp.to(roomRoom(room.code)).emit(EVENTS.DRIVER_CHANGED, { roomCode: room.code, driverId: room.driverId });
        return { roomCode: room.code, driverId: room.driverId };
      }),
    );

    socket.on(
      EVENTS.DRIVER_RELEASE,
      withAck(socket, (data) => {
        const { user, room } = requireOpenRoomParticipant(socket, data.roomCode);
        clearDriver(room, user.id);
        nsp.to(roomRoom(room.code)).emit(EVENTS.DRIVER_CHANGED, { roomCode: room.code, driverId: room.driverId });
        return { roomCode: room.code, driverId: room.driverId };
      }),
    );

    socket.on(
      EVENTS.PERMISSION_REQUEST,
      withAck(socket, (data) => {
        const { user, room, participant } = requireOpenRoomParticipant(socket, data.roomCode);
        if (participant.role !== "agent")
          throw new SupportError("FORBIDDEN", "Apenas atendentes podem solicitar permissões");

        const requested = parseSessionPermissions(data.permissions);
        room.pendingPermissions = normalizeSessionPermissions([
          ...(room.pendingPermissions ?? []),
          ...requested.filter((permission) => !(room.permissions ?? []).includes(permission)),
        ]);
        touch(room);

        const payload = { roomCode: room.code, permissions: requested };
        nsp.to(userRoom(room.ownerId)).emit(EVENTS.PERMISSION_REQUESTED, payload);
        emitPermissionState(room);
        emitLog(room, {
          actorId: user.id,
          type: "permission_requested",
          message: "Permissão solicitada",
          data: { permissions: requested },
        });
        return permissionState(room);
      }),
    );

    socket.on(
      EVENTS.PERMISSION_CANCEL,
      withAck(socket, (data) => {
        const { room, participant } = requireOpenRoomParticipant(socket, data.roomCode);
        if (participant.role !== "agent")
          throw new SupportError("FORBIDDEN", "Apenas atendentes podem cancelar solicitações");

        const cancelled = parseSessionPermissions(data.permissions);
        room.pendingPermissions = (room.pendingPermissions ?? []).filter(
          (permission) => !cancelled.includes(permission),
        );
        touch(room);
        emitPermissionState(room);
        return permissionState(room);
      }),
    );

    socket.on(
      EVENTS.PERMISSION_GRANT,
      withAck(socket, (data) => {
        const { user, room, participant } = requireOpenRoomParticipant(socket, data.roomCode);
        if (participant.role !== "requester")
          throw new SupportError("FORBIDDEN", "Apenas o dono da sala pode conceder permissões");

        const granted = applyGrant([], parseSessionPermissions(data.permissions));
        room.permissions = applyGrant(room.permissions, granted);
        room.pendingPermissions = (room.pendingPermissions ?? []).filter(
          (permission) => !granted.includes(permission),
        );
        touch(room);

        const payload = { roomCode: room.code, permissions: granted };
        nsp.to(roomRoom(room.code)).emit(EVENTS.PERMISSION_GRANTED, payload);
        emitPermissionState(room);
        emitLog(room, {
          actorId: user.id,
          type: "permission_granted",
          message: "Permissão concedida",
          data: { permissions: granted },
        });
        return permissionState(room);
      }),
    );

    socket.on(
      EVENTS.PERMISSION_REVOKE,
      withAck(socket, (data) => {
        const { user, room, participant } = requireOpenRoomParticipant(socket, data.roomCode);
        if (participant.role !== "requester")
          throw new SupportError("FORBIDDEN", "Apenas o dono da sala pode revogar permissões");

        const revoked = parseSessionPermissions(data.permissions);
        room.permissions = applyRevoke(room.permissions, revoked);
        room.pendingPermissions = applyRevoke(room.pendingPermissions, revoked);
        touch(room);

        // Sem ControlCoBrowsing, o piloto perde o token.
        if (!room.permissions.includes("ControlCoBrowsing") && room.driverId) {
          room.driverId = null;
          nsp.to(roomRoom(room.code)).emit(EVENTS.DRIVER_CHANGED, { roomCode: room.code, driverId: null });
        }

        const payload = { roomCode: room.code, permissions: revoked };
        nsp.to(roomRoom(room.code)).emit(EVENTS.PERMISSION_REVOKED, payload);
        emitPermissionState(room);
        emitLog(room, {
          actorId: user.id,
          type: "permission_revoked",
          message: "Permissão revogada",
          data: { permissions: revoked },
        });
        return permissionState(room);
      }),
    );

    // Sem ack no frontend: erros apenas logados.
    socket.on(EVENTS.PRESENCE_UPDATE, (envelope) => {
      const userId = socket.data.userId;
      const data = envelope?.data;
      if (!userId || !data?.roomCode) return;
      const room = rooms.get(data.roomCode);
      if (!room || room.status !== "open" || !room.participants[userId]) return;

      const presence = { ...data, userId, updatedAt: now() };
      socket.to(roomRoom(room.code)).emit(EVENTS.PRESENCE_UPDATED, presence);
    });

    socket.on(EVENTS.REMOTE_COMMAND, (envelope) => {
      const userId = socket.data.userId;
      const data = envelope?.data;
      if (!userId || !data?.roomCode || !data?.type) return;
      const room = rooms.get(data.roomCode);
      if (!room || room.status !== "open") return;
      const participant = room.participants[userId];
      if (!participant || participant.role !== "agent") return;
      if (!(room.permissions ?? []).includes("ControlCoBrowsing")) return;
      // Exclusão mútua: só o piloto atual pode emitir comandos. Sem claim explícito, nada acontece.
      if (room.driverId !== userId) return;

      const command = {
        ...data,
        issuedByParticipantId: userId,
        at: data.at ?? Date.now(),
      };
      nsp.to(userRoom(room.ownerId)).emit(EVENTS.REMOTE_COMMAND_RECEIVED, command);
      emitLog(room, {
        actorId: userId,
        type: "remote_command",
        message: `Comando remoto enviado (${command.type})`,
        data: {
          type: command.type,
          targetSupportId: command.targetSupportId ?? null,
          route: command.route,
        },
      });
    });

    socket.on(EVENTS.COBROWSING_EVENT, (envelope) => {
      const userId = socket.data.userId;
      const data = envelope?.data;
      if (!userId || !data?.roomCode || !data?.type) return;
      const room = rooms.get(data.roomCode);
      if (!room || room.status !== "open" || !room.participants[userId]) return;

      const event = appendCobrowsingEvent(room, {
        userId,
        type: data.type,
        payload: data.payload,
        operationTrace: envelope.operationTrace,
      });
      socket.to(roomRoom(room.code)).emit(EVENTS.COBROWSING_EVENT_RECEIVED, event);

      // Eventos de alta frequência não viram log.
      if (data.type !== "scroll_changed" && data.type !== "pointer_moved") {
        emitLog(room, {
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

      // Última conexão do usuário caiu: marca offline nas salas abertas.
      // O dono desconectado leva à sala fechada pelo sweeper (TTL); atendente
      // desconectado só fica marcado offline — a sala continua.
      broadcastAgents(user.contextCode);
      for (const room of rooms.values()) {
        const participant = room.participants[userId];
        if (room.status !== "open" || !participant) continue;
        participant.connected = false;
        participant.leftAt = now();
        if (room.driverId === userId) {
          room.driverId = null;
          nsp.to(roomRoom(room.code)).emit(EVENTS.DRIVER_CHANGED, { roomCode: room.code, driverId: null });
        }
        nsp.to(roomRoom(room.code)).emit(EVENTS.PARTICIPANT_LEFT, { userId });
      }
    });
  });
}
