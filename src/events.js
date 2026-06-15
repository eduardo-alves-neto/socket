// Espelha src/features/remote-support/events.ts do frontend.
export const EVENTS = {
  // client -> server (com ack)
  SUPPORT_REGISTER: "support:register",
  SUPPORT_AGENTS_LIST: "support:agents:list",
  SESSION_HEARTBEAT: "session:heartbeat",
  TICKET_CREATE: "ticket:create",
  TICKET_ACCEPT: "ticket:accept",
  SESSION_CONFIRM: "session:confirm",
  SESSION_FINISH: "session:finish",
  PRESENCE_UPDATE: "presence:update",
  COBROWSING_EVENT: "cobrowsing:event",

  // server -> client (broadcast)
  SUPPORT_BOOTSTRAP: "support:bootstrap",
  AGENTS_LIST: "agents:list",
  TICKET_CREATED: "ticket:created",
  TICKET_ACCEPTED: "ticket:accepted",
  SESSION_APPROVAL_REQUESTED: "session:approval_requested",
  SESSION_ACTIVE: "session:active",
  SESSION_FINISHED: "session:finished",
  PARTICIPANT_JOINED: "participant:joined",
  PARTICIPANT_LEFT: "participant:left",
  PRESENCE_UPDATED: "presence:updated",
  COBROWSING_EVENT_RECEIVED: "cobrowsing:event_received",
  LOG_APPENDED: "log:appended",
};

export const NAMESPACE = "/remote-support";
export const SOCKET_PATH = "/v1/remote-support/socket.io";

export const PERMISSIONS = {
  REQUEST: "remote-support.request",
  AGENT: "remote-support.agent",
};

// Altere TICKET_SECONDS para definir quantos segundos o atendente tem para aceitar o chamado.
const TICKET_SECONDS = 60;

export const TTL = {
  TICKET_MS: TICKET_SECONDS * 1000,
  APPROVAL_MS: 90 * 1000,
  SESSION_STALE_MS: 2 * 60 * 1000,
  SWEEP_INTERVAL_MS: 15 * 1000,
};
