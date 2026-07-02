import { randomUUID } from "node:crypto";
import { PERMISSIONS } from "./events.js";

const MAX_ROOM_EVENTS = 200;
const MAX_ROOM_LOGS = 200;

export const SESSION_PERMISSIONS = [
  "ViewCoBrowsing",
  "ControlCoBrowsing",
  "ShowRemotePointer",
];

const SESSION_PERMISSION_SET = new Set(SESSION_PERMISSIONS);
const IMPLIES = {
  ControlCoBrowsing: ["ViewCoBrowsing"],
  ShowRemotePointer: ["ViewCoBrowsing"],
};
const DEPENDENTS = {
  ViewCoBrowsing: ["ControlCoBrowsing", "ShowRemotePointer"],
};

export function isSessionPermission(permission) {
  return SESSION_PERMISSION_SET.has(permission);
}

export function normalizeSessionPermissions(permissions = []) {
  if (!Array.isArray(permissions)) return [];
  return SESSION_PERMISSIONS.filter((permission) => permissions.includes(permission));
}

export function expandGrant(permissions = []) {
  const normalized = normalizeSessionPermissions(permissions);
  const result = new Set();
  const visit = (permission) => {
    if (result.has(permission)) return;
    result.add(permission);
    for (const implied of IMPLIES[permission] ?? []) visit(implied);
  };
  normalized.forEach(visit);
  return SESSION_PERMISSIONS.filter((permission) => result.has(permission));
}

export function applyGrant(current = [], granted = []) {
  return expandGrant([...normalizeSessionPermissions(current), ...normalizeSessionPermissions(granted)]);
}

export function applyRevoke(current = [], revoked = []) {
  const normalized = normalizeSessionPermissions(current);
  const toRemove = new Set();
  const visit = (permission) => {
    if (toRemove.has(permission)) return;
    toRemove.add(permission);
    for (const dependent of DEPENDENTS[permission] ?? []) visit(dependent);
  };
  normalizeSessionPermissions(revoked).forEach(visit);
  return normalized.filter((permission) => !toRemove.has(permission));
}

// userId -> { id, contextCode, name, email, avatar, permissions: Set, sockets: Set<socketId> }
export const users = new Map();
// inviteId -> SupportInvite
export const invites = new Map();
// roomCode -> SupportRoom
export const rooms = new Map();
// inviteId -> Timeout (expiração de convite/aprovação)
export const timers = new Map();

export class SupportError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export function now() {
  return new Date().toISOString();
}

export function upsertUser(payload, contextCode, socketId) {
  let user = users.get(payload.userId);
  if (!user) {
    user = { id: payload.userId, sockets: new Set() };
    users.set(payload.userId, user);
  }
  user.contextCode = contextCode;
  user.name = payload.name ?? user.name ?? payload.userId;
  user.email = payload.email ?? user.email;
  user.avatar = payload.avatar ?? user.avatar;
  user.permissions = new Set(payload.permissions ?? [...(user.permissions ?? [])]);
  user.sockets.add(socketId);
  return user;
}

export function toAgent(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatar: user.avatar,
    online: user.sockets.size > 0,
  };
}

export function isAgent(user) {
  return user?.permissions?.has(PERMISSIONS.AGENT);
}

export function listAgents(contextCode) {
  return [...users.values()]
    .filter((u) => u.contextCode === contextCode && isAgent(u))
    .map(toAgent);
}

export function createParticipant(userId, role) {
  const ts = now();
  return {
    userId,
    role,
    connected: (users.get(userId)?.sockets.size ?? 0) > 0,
    joinedAt: ts,
    lastHeartbeatAt: ts,
  };
}

// Cria a sala imediatamente, já com o dono (requester) como participante.
// A sala não depende de nenhum convite específico — convites são criados à parte.
export function createRoom({ ownerId, mode, permissions = [] }) {
  const ts = now();
  const room = {
    code: randomUUID(),
    ownerId,
    mode,
    status: "open",
    driverId: null,
    participants: { [ownerId]: createParticipant(ownerId, "requester") },
    cobrowsingEvents: [],
    logs: [],
    permissions: applyGrant([], permissions),
    pendingPermissions: [],
    createdAt: ts,
    updatedAt: ts,
  };
  rooms.set(room.code, room);
  return room;
}

// Cria um convite individual e independente para um atendente. Não há convite "primário":
// cada um tem sua própria máquina de estados (pending -> awaiting_owner_approval -> joined).
export function createInvite({ roomCode, requesterId, agentId, mode, ttlMs }) {
  const ts = now();
  const invite = {
    id: randomUUID(),
    roomCode,
    requesterId,
    agentId,
    mode,
    status: "pending",
    createdAt: ts,
    updatedAt: ts,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
  invites.set(invite.id, invite);
  return invite;
}

export function touch(...records) {
  const ts = now();
  for (const record of records) record.updatedAt = ts;
}

export function joinParticipant(room, userId, role) {
  room.participants[userId] = {
    ...createParticipant(userId, role),
    ...room.participants[userId],
    connected: true,
  };
  touch(room);
  return room.participants[userId];
}

export function leaveParticipant(room, userId) {
  const participant = room.participants[userId];
  if (!participant) return null;
  delete room.participants[userId];
  if (room.driverId === userId) room.driverId = null;
  touch(room);
  return participant;
}

export function setDriver(room, agentId) {
  room.driverId = agentId;
  touch(room);
}

export function clearDriver(room, agentId) {
  if (room.driverId !== agentId) return false;
  room.driverId = null;
  touch(room);
  return true;
}

export function appendLog(room, { actorId, type, message, data }) {
  const log = {
    id: randomUUID(),
    roomCode: room.code,
    actorId,
    type,
    message,
    data,
    createdAt: now(),
  };
  room.logs.unshift(log);
  if (room.logs.length > MAX_ROOM_LOGS) room.logs.length = MAX_ROOM_LOGS;
  return log;
}

export function appendCobrowsingEvent(room, { userId, type, payload, operationTrace }) {
  const event = {
    id: randomUUID(),
    roomCode: room.code,
    userId,
    type,
    payload: payload ?? {},
    operationTrace,
    createdAt: now(),
  };
  room.cobrowsingEvents.unshift(event);
  if (room.cobrowsingEvents.length > MAX_ROOM_EVENTS)
    room.cobrowsingEvents.length = MAX_ROOM_EVENTS;
  return event;
}

const OPEN_INVITE_STATUSES = new Set(["pending", "awaiting_owner_approval"]);

export function isOpenInvite(invite) {
  return OPEN_INVITE_STATUSES.has(invite.status);
}

export function buildBootstrap(user) {
  const userRooms = [...rooms.values()].filter(
    (r) => r.status === "open" && r.participants[user.id],
  );
  const userInvites = [...invites.values()].filter(
    (i) => isOpenInvite(i) && (i.requesterId === user.id || i.agentId === user.id),
  );
  return {
    user: toAgent(user),
    agents: listAgents(user.contextCode),
    rooms: userRooms,
    invites: userInvites,
  };
}

export function clearTimer(inviteId) {
  const timer = timers.get(inviteId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(inviteId);
  }
}

export function setTimer(inviteId, fn, ms) {
  clearTimer(inviteId);
  const timer = setTimeout(() => {
    timers.delete(inviteId);
    fn();
  }, ms);
  timer.unref?.();
  timers.set(inviteId, timer);
}
