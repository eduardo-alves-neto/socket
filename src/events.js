// Espelha src/features/remote-support/constants/events.ts do frontend.
export const EVENTS = {
  // client -> server (com ack)
  SUPPORT_REGISTER: "support:register",
  SUPPORT_AGENTS_LIST: "support:agents:list",
  ROOM_HEARTBEAT: "room:heartbeat",
  ROOM_CREATE: "room:create",
  ROOM_INVITE: "room:invite",
  ROOM_LEAVE: "room:leave",
  ROOM_CLOSE: "room:close",
  INVITE_ACCEPT: "invite:accept",
  INVITE_DECLINE: "invite:decline",
  INVITE_CANCEL: "invite:cancel",
  INVITE_APPROVE: "invite:approve",
  DRIVER_CLAIM: "driver:claim",
  DRIVER_RELEASE: "driver:release",
  PRESENCE_UPDATE: "presence:update",
  COBROWSING_EVENT: "cobrowsing:event",
  PERMISSION_REQUEST: "permission:request",
  PERMISSION_CANCEL: "permission:cancel",
  PERMISSION_GRANT: "permission:grant",
  PERMISSION_REVOKE: "permission:revoke",
  REMOTE_COMMAND: "remote:command",

  // server -> client (broadcast)
  SUPPORT_BOOTSTRAP: "support:bootstrap",
  AGENTS_LIST: "agents:list",
  ROOM_CREATED: "room:created",
  ROOM_UPDATED: "room:updated",
  ROOM_CLOSED: "room:closed",
  INVITE_RECEIVED: "invite:received",
  INVITE_UPDATED: "invite:updated",
  OWNER_APPROVAL_REQUESTED: "owner:approval_requested",
  PARTICIPANT_JOINED: "participant:joined",
  PARTICIPANT_LEFT: "participant:left",
  DRIVER_CHANGED: "driver:changed",
  PRESENCE_UPDATED: "presence:updated",
  COBROWSING_EVENT_RECEIVED: "cobrowsing:event_received",
  LOG_APPENDED: "log:appended",
  PERMISSION_REQUESTED: "permission:requested",
  PERMISSION_GRANTED: "permission:granted",
  PERMISSION_REVOKED: "permission:revoked",
  PERMISSION_STATE: "permission:state",
  REMOTE_COMMAND_RECEIVED: "remote:command_received",
};

export const NAMESPACE = "/remote-support";
export const SOCKET_PATH = "/v1/remote-support/socket.io";

export const PERMISSIONS = {
  REQUEST: "remote-support.request",
  AGENT: "remote-support.agent",
};

// Altere INVITE_SECONDS para definir quantos segundos o atendente tem para responder ao convite.
const INVITE_SECONDS = 60;

export const TTL = {
  INVITE_MS: INVITE_SECONDS * 1000,
  APPROVAL_MS: 90 * 1000,
  ROOM_STALE_MS: 2 * 60 * 1000,
  SWEEP_INTERVAL_MS: 15 * 1000,
};
