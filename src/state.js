import { randomUUID } from "node:crypto";
import { PERMISSIONS } from "./events.js";

const MAX_SESSION_EVENTS = 200;
const MAX_SESSION_LOGS = 200;

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
// ticketId -> SupportTicket
export const tickets = new Map();
// sessionCode -> SupportSession
export const sessions = new Map();
// ticketId -> Timeout (expiração de ticket/aprovação)
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

export function createSessionWithTickets({ requesterId, agentIds, mode, ttlMs, permissions = [] }) {
  const ts = now();
  const sessionCode = randomUUID();
  const session = {
    code: sessionCode,
    requesterId,
    agentIds,
    mode,
    status: "requested",
    participants: { [requesterId]: createParticipant(requesterId, "requester") },
    cobrowsingEvents: [],
    logs: [],
    permissions: applyGrant([], permissions),
    pendingPermissions: [],
    createdAt: ts,
    updatedAt: ts,
  };
  sessions.set(session.code, session);

  const createdTickets = agentIds.map((agentId) => {
    const ticket = {
      id: randomUUID(),
      sessionCode,
      requesterId,
      agentId,
      mode,
      status: "requested",
      createdAt: ts,
      updatedAt: ts,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
    tickets.set(ticket.id, ticket);
    return ticket;
  });

  return { session, tickets: createdTickets };
}

export function createTicketWithSession({ requesterId, agentId, mode, ttlMs, permissions = [] }) {
  const ts = now();
  const ticket = {
    id: randomUUID(),
    sessionCode: randomUUID(),
    requesterId,
    agentId,
    mode,
    status: "requested",
    createdAt: ts,
    updatedAt: ts,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
  const session = {
    code: ticket.sessionCode,
    ticketId: ticket.id,
    requesterId,
    agentId,
    mode,
    status: "requested",
    participants: { [requesterId]: createParticipant(requesterId, "requester") },
    cobrowsingEvents: [],
    logs: [],
    permissions: applyGrant([], permissions),
    pendingPermissions: [],
    createdAt: ts,
    updatedAt: ts,
  };
  tickets.set(ticket.id, ticket);
  sessions.set(session.code, session);
  return { ticket, session };
}

export function appendLog(session, { actorId, type, message, data }) {
  const log = {
    id: randomUUID(),
    sessionCode: session.code,
    actorId,
    type,
    message,
    data,
    createdAt: now(),
  };
  session.logs.unshift(log);
  if (session.logs.length > MAX_SESSION_LOGS) session.logs.length = MAX_SESSION_LOGS;
  return log;
}

export function appendCobrowsingEvent(session, { userId, type, payload, operationTrace }) {
  const event = {
    id: randomUUID(),
    sessionCode: session.code,
    userId,
    type,
    payload: payload ?? {},
    operationTrace,
    createdAt: now(),
  };
  session.cobrowsingEvents.unshift(event);
  if (session.cobrowsingEvents.length > MAX_SESSION_EVENTS)
    session.cobrowsingEvents.length = MAX_SESSION_EVENTS;
  return event;
}

const OPEN_TICKET_STATUSES = new Set(["requested", "waiting_user_approval", "active"]);

export function isOpenTicket(ticket) {
  return OPEN_TICKET_STATUSES.has(ticket.status);
}

export function buildBootstrap(user) {
  const userTickets = [...tickets.values()].filter(
    (t) => isOpenTicket(t) && (t.requesterId === user.id || t.agentId === user.id),
  );
  const userSessions = [...sessions.values()].filter(
    (s) => s.status === "active" && s.participants[user.id],
  );
  return {
    user: toAgent(user),
    agents: listAgents(user.contextCode),
    tickets: userTickets,
    sessions: userSessions,
  };
}

export function clearTimer(ticketId) {
  const timer = timers.get(ticketId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(ticketId);
  }
}

export function setTimer(ticketId, fn, ms) {
  clearTimer(ticketId);
  const timer = setTimeout(() => {
    timers.delete(ticketId);
    fn();
  }, ms);
  timer.unref?.();
  timers.set(ticketId, timer);
}
