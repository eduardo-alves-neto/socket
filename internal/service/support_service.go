package service

import (
	"context"
	"sort"
	"time"

	"remote-support/internal/config"
	"remote-support/internal/domain"
	"remote-support/internal/permissions"
	"remote-support/internal/store"
)

type Clock interface {
	Now() time.Time
}

type SystemClock struct{}

func (SystemClock) Now() time.Time {
	return time.Now().UTC()
}

type Realtime interface {
	BindUserSocket(ctx context.Context, userID string, socketID string) error
	UnbindSocket(ctx context.Context, socketID string) error
	JoinUser(ctx context.Context, userID string, room string) error
	LeaveUser(ctx context.Context, userID string, room string) error
	EmitToUser(ctx context.Context, userID string, event string, payload any) error
	EmitToRoom(ctx context.Context, room string, event string, payload any) error
	EmitAll(ctx context.Context, event string, payload any) error
}

type noopRealtime struct{}

func (noopRealtime) BindUserSocket(context.Context, string, string) error { return nil }
func (noopRealtime) UnbindSocket(context.Context, string) error           { return nil }
func (noopRealtime) JoinUser(context.Context, string, string) error       { return nil }
func (noopRealtime) LeaveUser(context.Context, string, string) error      { return nil }
func (noopRealtime) EmitToUser(context.Context, string, string, any) error { return nil }
func (noopRealtime) EmitToRoom(context.Context, string, string, any) error { return nil }
func (noopRealtime) EmitAll(context.Context, string, any) error            { return nil }

type Option func(*Service)

func WithClock(clock Clock) Option {
	return func(s *Service) {
		if clock != nil {
			s.clock = clock
		}
	}
}

type Service struct {
	repo     store.Repository
	cfg      config.Config
	realtime Realtime
	clock    Clock
}

func New(repo store.Repository, cfg config.Config, realtime Realtime, opts ...Option) *Service {
	if realtime == nil {
		realtime = noopRealtime{}
	}

	s := &Service{
		repo:     repo,
		cfg:      cfg,
		realtime: realtime,
		clock:    SystemClock{},
	}

	for _, opt := range opts {
		opt(s)
	}

	return s
}

type RegisterInput struct {
	SocketID    string
	UserID      string
	Name        string
	Roles       []string
	Permissions []string
}

type Bootstrap struct {
	User     domain.SupportUser      `json:"user"`
	Agents   []domain.SupportUser    `json:"agents"`
	Tickets  []domain.SupportTicket   `json:"tickets"`
	Sessions []domain.SupportSession  `json:"sessions"`
}

type RegisterOutput struct {
	User      domain.SupportUser `json:"user"`
	Bootstrap Bootstrap          `json:"bootstrap"`
}

type ListAgentsOutput struct {
	Agents []domain.SupportUser `json:"agents"`
}

type CreateTicketInput struct {
	RequesterID    string
	AgentID        string
	Mode           domain.SessionMode
	OperationTrace string
}

type CreateTicketOutput struct {
	Ticket  domain.SupportTicket  `json:"ticket"`
	Session domain.SupportSession `json:"session"`
}

type AcceptTicketInput struct {
	AgentID        string
	TicketID       string
	OperationTrace string
}

type AcceptTicketOutput struct {
	Ticket  domain.SupportTicket  `json:"ticket"`
	Session domain.SupportSession `json:"session"`
}

type ConfirmSessionInput struct {
	UserID         string
	SessionCode    string
	Approved       bool
	OperationTrace string
}

type ConfirmSessionOutput struct {
	Ticket  domain.SupportTicket  `json:"ticket"`
	Session domain.SupportSession `json:"session"`
}

type FinishSessionInput struct {
	UserID         string
	SessionCode    string
	Reason         string
	OperationTrace string
}

type FinishSessionOutput struct {
	Ticket  domain.SupportTicket  `json:"ticket"`
	Session domain.SupportSession `json:"session"`
}

type HeartbeatInput struct {
	UserID      string
	SessionCode string
}

type HeartbeatOutput struct {
	Session domain.SupportSession `json:"session"`
}

type UpdatePresenceInput struct {
	UserID      string
	SessionCode string
	Presence    domain.PresenceState
}

type UpdatePresenceOutput struct {
	Presence domain.PresenceState `json:"presence"`
}

type CobrowsingEventInput struct {
	UserID         string
	SessionCode    string
	Type           string
	Payload        map[string]any
	OperationTrace string
}

type CobrowsingEventOutput struct {
	Event domain.CobrowsingEvent `json:"event"`
}

type DisconnectOutput struct {
	UserID string `json:"userId,omitempty"`
}

type effectKind string

const (
	effectBindUserSocket effectKind = "bind_user_socket"
	effectUnbindSocket   effectKind = "unbind_socket"
	effectJoinUser       effectKind = "join_user"
	effectLeaveUser      effectKind = "leave_user"
	effectEmitUser       effectKind = "emit_user"
	effectEmitRoom       effectKind = "emit_room"
	effectEmitAll        effectKind = "emit_all"
)

type effect struct {
	kind     effectKind
	userID   string
	socketID string
	room     string
	event    string
	payload  any
}

func (s *Service) Register(ctx context.Context, in RegisterInput) (RegisterOutput, error) {
	if in.SocketID == "" {
		return RegisterOutput{}, domain.InvalidPayload("socketId e obrigatorio", nil)
	}
	if in.UserID == "" {
		return RegisterOutput{}, domain.InvalidPayload("userId e obrigatorio", nil)
	}
	if in.Name == "" {
		return RegisterOutput{}, domain.InvalidPayload("name e obrigatorio", nil)
	}

	now := s.now()
	resolvedPermissions := permissions.Resolve(in.Roles, in.Permissions)

	var out RegisterOutput
	var effects []effect

	err := s.repo.Update(func(st *store.State) error {
		previous, existed := st.Users[in.UserID]
		if existed && previous.SocketID != "" && previous.SocketID != in.SocketID {
			delete(st.SocketToUser, previous.SocketID)
			effects = append(effects, effect{kind: effectUnbindSocket, socketID: previous.SocketID})
		}

		registeredAt := now
		if existed && !previous.RegisteredAt.IsZero() {
			registeredAt = previous.RegisteredAt
		}

		user := domain.SupportUser{
			ID:           in.UserID,
			Name:         in.Name,
			Roles:        cloneStrings(in.Roles),
			Permissions:  resolvedPermissions,
			SocketID:     in.SocketID,
			Online:       true,
			RegisteredAt: registeredAt,
			LastSeenAt:   now,
		}

		st.Users[user.ID] = user
		st.SocketToUser[in.SocketID] = user.ID

		effects = append(effects, effect{kind: effectBindUserSocket, userID: user.ID, socketID: in.SocketID})

		for code, session := range st.Sessions {
			if domain.IsTerminalStatus(session.Status) || session.Participants == nil {
				continue
			}

			participant, ok := session.Participants[user.ID]
			if !ok {
				continue
			}

			participant.SocketID = in.SocketID
			participant.Connected = true
			participant.LeftAt = nil
			if participant.LastHeartbeatAt.IsZero() {
				participant.LastHeartbeatAt = now
			}
			session.Participants[user.ID] = participant
			session.UpdatedAt = now

			if session.RequesterID == user.ID {
				session.NoAssistedExpiresAt = nil
			}

			st.Sessions[code] = session

			room := domain.SessionRoom(code)
			effects = append(effects,
				effect{kind: effectJoinUser, userID: user.ID, room: room},
				effect{kind: effectEmitRoom, room: room, event: "participant:joined", payload: participant},
			)
		}

		out.User = user
		out.Bootstrap = buildBootstrap(st, user.ID)
		effects = append(effects, effect{kind: effectEmitUser, userID: user.ID, event: "support:bootstrap", payload: out.Bootstrap})
		return nil
	})
	if err != nil {
		return RegisterOutput{}, err
	}

	s.dispatch(ctx, effects)
	return out, nil
}

func (s *Service) ListAgents(ctx context.Context, requesterID string) (ListAgentsOutput, error) {
	_ = ctx
	var out ListAgentsOutput

	err := s.repo.View(func(st *store.State) error {
		requester, ok := st.Users[requesterID]
		if !ok {
			return domain.NotFound("usuario nao registrado", map[string]any{"userId": requesterID})
		}
		if !requester.HasPermission(domain.PermissionRequest) {
			return domain.Forbidden("usuario nao pode solicitar suporte remoto", map[string]any{"permission": domain.PermissionRequest})
		}

		out.Agents = listOnlineAgents(st)
		return nil
	})

	return out, err
}

func (s *Service) CreateTicket(ctx context.Context, in CreateTicketInput) (CreateTicketOutput, error) {
	if in.RequesterID == "" {
		return CreateTicketOutput{}, domain.InvalidPayload("requesterId e obrigatorio", nil)
	}
	if in.AgentID == "" {
		return CreateTicketOutput{}, domain.InvalidPayload("agentId e obrigatorio", nil)
	}
	if !domain.IsValidSessionMode(in.Mode) {
		return CreateTicketOutput{}, domain.InvalidPayload("mode deve ser assisted ou shared", map[string]any{"mode": in.Mode})
	}

	now := s.now()
	var out CreateTicketOutput
	var effects []effect

	err := s.repo.Update(func(st *store.State) error {
		requester, ok := st.Users[in.RequesterID]
		if !ok {
			return domain.NotFound("solicitante nao registrado", map[string]any{"userId": in.RequesterID})
		}
		if !requester.HasPermission(domain.PermissionRequest) {
			return domain.Forbidden("usuario nao pode solicitar suporte remoto", map[string]any{"permission": domain.PermissionRequest})
		}

		agent, ok := st.Users[in.AgentID]
		if !ok {
			return domain.NotFound("atendente nao encontrado", map[string]any{"agentId": in.AgentID})
		}
		if !agent.Online || !agent.HasPermission(domain.PermissionAgent) {
			return domain.Forbidden("atendente indisponivel", map[string]any{"agentId": in.AgentID})
		}

		ticketID := st.NextID("ticket")
		sessionCode := st.NextSessionCode()

		ticket := domain.SupportTicket{
			ID:          ticketID,
			SessionCode: sessionCode,
			RequesterID: requester.ID,
			AgentID:     agent.ID,
			Mode:        in.Mode,
			Status:      domain.StatusRequested,
			CreatedAt:   now,
			UpdatedAt:   now,
			ExpiresAt:   now.Add(s.cfg.TicketTTL),
		}

		session := domain.SupportSession{
			Code:             sessionCode,
			TicketID:         ticketID,
			RequesterID:      requester.ID,
			AgentID:          agent.ID,
			Mode:             in.Mode,
			Status:           domain.StatusRequested,
			Participants:     make(map[string]domain.SupportParticipant),
			Presence:         make(map[string]domain.PresenceState),
			CobrowsingEvents: make([]domain.CobrowsingEvent, 0),
			Logs:             make([]domain.SupportLogEntry, 0),
			CreatedAt:        now,
			UpdatedAt:        now,
		}

		session.Logs = append(session.Logs, newLog(st, sessionCode, requester.ID, "ticket_created", "Chamado criado", in.OperationTrace, map[string]any{
			"mode":    in.Mode,
			"agentId": agent.ID,
		}, now))

		st.Tickets[ticket.ID] = ticket
		st.Sessions[session.Code] = session

		out.Ticket = ticket
		out.Session = session
		effects = append(effects, effect{kind: effectEmitUser, userID: agent.ID, event: "ticket:created", payload: out})
		return nil
	})
	if err != nil {
		return CreateTicketOutput{}, err
	}

	s.dispatch(ctx, effects)
	return out, nil
}

func (s *Service) AcceptTicket(ctx context.Context, in AcceptTicketInput) (AcceptTicketOutput, error) {
	if in.AgentID == "" {
		return AcceptTicketOutput{}, domain.InvalidPayload("agentId e obrigatorio", nil)
	}
	if in.TicketID == "" {
		return AcceptTicketOutput{}, domain.InvalidPayload("ticketId e obrigatorio", nil)
	}

	now := s.now()
	var out AcceptTicketOutput
	var effects []effect

	err := s.repo.Update(func(st *store.State) error {
		agent, ok := st.Users[in.AgentID]
		if !ok {
			return domain.NotFound("atendente nao registrado", map[string]any{"agentId": in.AgentID})
		}
		if !agent.HasPermission(domain.PermissionAgent) {
			return domain.Forbidden("usuario nao pode aceitar chamados", map[string]any{"permission": domain.PermissionAgent})
		}

		ticket, ok := st.Tickets[in.TicketID]
		if !ok {
			return domain.NotFound("chamado nao encontrado", map[string]any{"ticketId": in.TicketID})
		}
		if ticket.Status == domain.StatusRequested && !now.Before(ticket.ExpiresAt) {
			if err := expireRequestedTicket(st, &ticket, now, "ticket_ttl"); err != nil {
				return err
			}
			st.Tickets[ticket.ID] = ticket
			session := st.Sessions[ticket.SessionCode]
			out.Ticket = ticket
			out.Session = session
			effects = appendSessionFinishedEffects(effects, session, ticket, "expired")
			return domain.Expired("chamado expirado", map[string]any{"ticketId": in.TicketID})
		}
		if ticket.AgentID != "" && ticket.AgentID != in.AgentID {
			return domain.Forbidden("chamado direcionado para outro atendente", map[string]any{"agentId": ticket.AgentID})
		}
		if err := domain.Transition(ticket.Status, domain.StatusWaitingUserApproval); err != nil {
			return err
		}

		session, ok := st.Sessions[ticket.SessionCode]
		if !ok {
			return domain.NotFound("sessao do chamado nao encontrada", map[string]any{"sessionCode": ticket.SessionCode})
		}

		approvalExpiresAt := now.Add(s.cfg.ApprovalTTL)
		ticket.Status = domain.StatusWaitingUserApproval
		ticket.AgentID = in.AgentID
		ticket.AcceptedAt = &now
		ticket.ApprovalExpiresAt = &approvalExpiresAt
		ticket.UpdatedAt = now

		session.Status = domain.StatusWaitingUserApproval
		session.AgentID = in.AgentID
		session.AcceptedAt = &now
		session.ApprovalExpiresAt = &approvalExpiresAt
		session.UpdatedAt = now
		session.Participants[in.AgentID] = domain.SupportParticipant{
			UserID:          in.AgentID,
			SocketID:        agent.SocketID,
			Role:            domain.ParticipantAgent,
			Connected:       agent.Online,
			JoinedAt:        now,
			LastHeartbeatAt: now,
		}
		logEntry := newLog(st, session.Code, in.AgentID, "ticket_accepted", "Chamado aceito pelo atendente", in.OperationTrace, nil, now)
		session.Logs = append(session.Logs, logEntry)

		st.Tickets[ticket.ID] = ticket
		st.Sessions[session.Code] = session

		out.Ticket = ticket
		out.Session = session

		room := domain.SessionRoom(session.Code)
		effects = append(effects,
			effect{kind: effectJoinUser, userID: in.AgentID, room: room},
			effect{kind: effectEmitUser, userID: ticket.RequesterID, event: "ticket:accepted", payload: out},
			effect{kind: effectEmitUser, userID: ticket.RequesterID, event: "session:approval_requested", payload: out},
			effect{kind: effectEmitRoom, room: room, event: "ticket:accepted", payload: out},
			effect{kind: effectEmitRoom, room: room, event: "log:appended", payload: logEntry},
		)
		return nil
	})
	if err != nil {
		s.dispatch(ctx, effects)
		return AcceptTicketOutput{}, err
	}

	s.dispatch(ctx, effects)
	return out, nil
}

func (s *Service) ConfirmSession(ctx context.Context, in ConfirmSessionInput) (ConfirmSessionOutput, error) {
	if in.UserID == "" {
		return ConfirmSessionOutput{}, domain.InvalidPayload("userId e obrigatorio", nil)
	}
	if in.SessionCode == "" {
		return ConfirmSessionOutput{}, domain.InvalidPayload("sessionCode e obrigatorio", nil)
	}

	now := s.now()
	var out ConfirmSessionOutput
	var effects []effect

	err := s.repo.Update(func(st *store.State) error {
		session, ok := st.Sessions[in.SessionCode]
		if !ok {
			return domain.NotFound("sessao nao encontrada", map[string]any{"sessionCode": in.SessionCode})
		}
		if session.RequesterID != in.UserID {
			return domain.Forbidden("somente o usuario assistido pode confirmar a sessao", nil)
		}

		ticket, ok := st.Tickets[session.TicketID]
		if !ok {
			return domain.NotFound("chamado da sessao nao encontrado", map[string]any{"ticketId": session.TicketID})
		}

		if session.Status == domain.StatusWaitingUserApproval && session.ApprovalExpiresAt != nil && !now.Before(*session.ApprovalExpiresAt) {
			if err := expireWaitingSession(st, &ticket, &session, now, "approval_ttl"); err != nil {
				return err
			}
			st.Tickets[ticket.ID] = ticket
			st.Sessions[session.Code] = session
			out.Ticket = ticket
			out.Session = session
			effects = appendSessionFinishedEffects(effects, session, ticket, "expired")
			return domain.Expired("confirmacao expirada", map[string]any{"sessionCode": in.SessionCode})
		}
		if err := domain.Transition(session.Status, statusAfterConfirmation(in.Approved)); err != nil {
			return err
		}

		if !in.Approved {
			session.Status = domain.StatusRejected
			session.FinishedAt = &now
			session.FinishReason = "approval_rejected"
			session.UpdatedAt = now
			ticket.Status = domain.StatusRejected
			ticket.FinishedAt = &now
			ticket.FinishReason = "approval_rejected"
			ticket.UpdatedAt = now
			logEntry := newLog(st, session.Code, in.UserID, "session_rejected", "Sessao rejeitada pelo usuario", in.OperationTrace, nil, now)
			session.Logs = append(session.Logs, logEntry)

			st.Tickets[ticket.ID] = ticket
			st.Sessions[session.Code] = session

			out.Ticket = ticket
			out.Session = session
			effects = appendSessionFinishedEffects(effects, session, ticket, "rejected")
			return nil
		}

		requester, ok := st.Users[in.UserID]
		if !ok {
			return domain.NotFound("usuario assistido nao registrado", map[string]any{"userId": in.UserID})
		}
		agent, ok := st.Users[session.AgentID]
		if !ok {
			return domain.NotFound("atendente nao registrado", map[string]any{"agentId": session.AgentID})
		}

		session.Status = domain.StatusActive
		session.ActiveAt = &now
		session.UpdatedAt = now
		session.NoAssistedExpiresAt = nil
		session.Participants[in.UserID] = domain.SupportParticipant{
			UserID:          in.UserID,
			SocketID:        requester.SocketID,
			Role:            domain.ParticipantRequester,
			Connected:       requester.Online,
			JoinedAt:        now,
			LastHeartbeatAt: now,
		}
		session.Participants[session.AgentID] = domain.SupportParticipant{
			UserID:          session.AgentID,
			SocketID:        agent.SocketID,
			Role:            domain.ParticipantAgent,
			Connected:       agent.Online,
			JoinedAt:        now,
			LastHeartbeatAt: now,
		}
		ticket.Status = domain.StatusActive
		ticket.UpdatedAt = now
		logEntry := newLog(st, session.Code, in.UserID, "session_active", "Sessao ativada pelo usuario", in.OperationTrace, nil, now)
		session.Logs = append(session.Logs, logEntry)

		st.Tickets[ticket.ID] = ticket
		st.Sessions[session.Code] = session

		out.Ticket = ticket
		out.Session = session

		room := domain.SessionRoom(session.Code)
		effects = append(effects,
			effect{kind: effectJoinUser, userID: in.UserID, room: room},
			effect{kind: effectJoinUser, userID: session.AgentID, room: room},
			effect{kind: effectEmitRoom, room: room, event: "participant:joined", payload: session.Participants[in.UserID]},
			effect{kind: effectEmitRoom, room: room, event: "participant:joined", payload: session.Participants[session.AgentID]},
			effect{kind: effectEmitRoom, room: room, event: "session:active", payload: out},
			effect{kind: effectEmitRoom, room: room, event: "log:appended", payload: logEntry},
		)
		return nil
	})
	if err != nil {
		s.dispatch(ctx, effects)
		return ConfirmSessionOutput{}, err
	}

	s.dispatch(ctx, effects)
	return out, nil
}

func (s *Service) FinishSession(ctx context.Context, in FinishSessionInput) (FinishSessionOutput, error) {
	if in.UserID == "" {
		return FinishSessionOutput{}, domain.InvalidPayload("userId e obrigatorio", nil)
	}
	if in.SessionCode == "" {
		return FinishSessionOutput{}, domain.InvalidPayload("sessionCode e obrigatorio", nil)
	}
	if in.Reason == "" {
		in.Reason = "manual_finish"
	}

	now := s.now()
	var out FinishSessionOutput
	var effects []effect

	err := s.repo.Update(func(st *store.State) error {
		session, ok := st.Sessions[in.SessionCode]
		if !ok {
			return domain.NotFound("sessao nao encontrada", map[string]any{"sessionCode": in.SessionCode})
		}
		if !isSessionParticipant(session, in.UserID) {
			return domain.Forbidden("usuario nao participa da sessao", map[string]any{"userId": in.UserID})
		}
		if err := domain.Transition(session.Status, domain.StatusFinished); err != nil {
			return err
		}

		ticket, ok := st.Tickets[session.TicketID]
		if !ok {
			return domain.NotFound("chamado da sessao nao encontrado", map[string]any{"ticketId": session.TicketID})
		}

		finishSession(st, &ticket, &session, now, in.Reason, in.UserID, in.OperationTrace)
		st.Tickets[ticket.ID] = ticket
		st.Sessions[session.Code] = session

		out.Ticket = ticket
		out.Session = session
		effects = appendSessionFinishedEffects(effects, session, ticket, in.Reason)
		effects = appendLeaveParticipantsEffects(effects, session)
		return nil
	})
	if err != nil {
		return FinishSessionOutput{}, err
	}

	s.dispatch(ctx, effects)
	return out, nil
}

func (s *Service) Heartbeat(ctx context.Context, in HeartbeatInput) (HeartbeatOutput, error) {
	if in.UserID == "" {
		return HeartbeatOutput{}, domain.InvalidPayload("userId e obrigatorio", nil)
	}
	if in.SessionCode == "" {
		return HeartbeatOutput{}, domain.InvalidPayload("sessionCode e obrigatorio", nil)
	}

	now := s.now()
	var out HeartbeatOutput
	var effects []effect

	err := s.repo.Update(func(st *store.State) error {
		session, ok := st.Sessions[in.SessionCode]
		if !ok {
			return domain.NotFound("sessao nao encontrada", map[string]any{"sessionCode": in.SessionCode})
		}
		if session.Status != domain.StatusActive {
			return domain.InvalidState("heartbeat exige sessao ativa", map[string]any{"status": session.Status})
		}

		participant, ok := session.Participants[in.UserID]
		if !ok {
			return domain.Forbidden("usuario nao participa da sessao", map[string]any{"userId": in.UserID})
		}

		wasDisconnected := !participant.Connected
		participant.Connected = true
		participant.LeftAt = nil
		participant.LastHeartbeatAt = now
		session.Participants[in.UserID] = participant
		session.UpdatedAt = now

		if session.RequesterID == in.UserID {
			session.NoAssistedExpiresAt = nil
		}

		st.Sessions[session.Code] = session
		out.Session = session

		if wasDisconnected {
			room := domain.SessionRoom(session.Code)
			effects = append(effects,
				effect{kind: effectJoinUser, userID: in.UserID, room: room},
				effect{kind: effectEmitRoom, room: room, event: "participant:joined", payload: participant},
			)
		}

		return nil
	})
	if err != nil {
		return HeartbeatOutput{}, err
	}

	s.dispatch(ctx, effects)
	return out, nil
}

func (s *Service) UpdatePresence(ctx context.Context, in UpdatePresenceInput) (UpdatePresenceOutput, error) {
	if in.UserID == "" {
		return UpdatePresenceOutput{}, domain.InvalidPayload("userId e obrigatorio", nil)
	}
	if in.SessionCode == "" {
		return UpdatePresenceOutput{}, domain.InvalidPayload("sessionCode e obrigatorio", nil)
	}

	now := s.now()
	var out UpdatePresenceOutput
	var effects []effect

	err := s.repo.Update(func(st *store.State) error {
		session, err := requireActiveParticipant(st, in.SessionCode, in.UserID)
		if err != nil {
			return err
		}

		presence := in.Presence
		presence.SessionCode = in.SessionCode
		presence.UserID = in.UserID
		presence.UpdatedAt = now
		session.Presence[in.UserID] = presence
		session.UpdatedAt = now
		st.Sessions[session.Code] = session

		out.Presence = presence
		effects = append(effects, effect{kind: effectEmitRoom, room: domain.SessionRoom(session.Code), event: "presence:updated", payload: presence})
		return nil
	})
	if err != nil {
		return UpdatePresenceOutput{}, err
	}

	s.dispatch(ctx, effects)
	return out, nil
}

func (s *Service) CobrowsingEvent(ctx context.Context, in CobrowsingEventInput) (CobrowsingEventOutput, error) {
	if in.UserID == "" {
		return CobrowsingEventOutput{}, domain.InvalidPayload("userId e obrigatorio", nil)
	}
	if in.SessionCode == "" {
		return CobrowsingEventOutput{}, domain.InvalidPayload("sessionCode e obrigatorio", nil)
	}
	if in.Type == "" {
		return CobrowsingEventOutput{}, domain.InvalidPayload("type e obrigatorio", nil)
	}

	now := s.now()
	var out CobrowsingEventOutput
	var effects []effect

	err := s.repo.Update(func(st *store.State) error {
		session, err := requireActiveParticipant(st, in.SessionCode, in.UserID)
		if err != nil {
			return err
		}

		event := domain.CobrowsingEvent{
			ID:             st.NextID("cobrowse"),
			SessionCode:    in.SessionCode,
			UserID:         in.UserID,
			Type:           in.Type,
			Payload:        cloneMap(in.Payload),
			OperationTrace: in.OperationTrace,
			CreatedAt:      now,
		}
		session.CobrowsingEvents = append(session.CobrowsingEvents, event)
		session.UpdatedAt = now
		st.Sessions[session.Code] = session

		out.Event = event
		effects = append(effects, effect{kind: effectEmitRoom, room: domain.SessionRoom(session.Code), event: "cobrowsing:event_received", payload: event})
		return nil
	})
	if err != nil {
		return CobrowsingEventOutput{}, err
	}

	s.dispatch(ctx, effects)
	return out, nil
}

func (s *Service) DisconnectSocket(ctx context.Context, socketID string) (DisconnectOutput, error) {
	if socketID == "" {
		return DisconnectOutput{}, domain.InvalidPayload("socketId e obrigatorio", nil)
	}

	now := s.now()
	var out DisconnectOutput
	var effects []effect

	err := s.repo.Update(func(st *store.State) error {
		userID, ok := st.SocketToUser[socketID]
		if !ok {
			effects = append(effects, effect{kind: effectUnbindSocket, socketID: socketID})
			return nil
		}

		delete(st.SocketToUser, socketID)

		user := st.Users[userID]
		user.Online = false
		user.SocketID = ""
		user.LastSeenAt = now
		st.Users[userID] = user
		out.UserID = userID

		for code, session := range st.Sessions {
			if domain.IsTerminalStatus(session.Status) || session.Participants == nil {
				continue
			}

			participant, ok := session.Participants[userID]
			if !ok || participant.SocketID != socketID {
				continue
			}

			participant.Connected = false
			participant.LeftAt = &now
			session.Participants[userID] = participant
			session.UpdatedAt = now

			if session.Status == domain.StatusActive && session.RequesterID == userID {
				expiresAt := now.Add(s.cfg.NoAssistedTTL)
				session.NoAssistedExpiresAt = &expiresAt
			}

			st.Sessions[code] = session

			room := domain.SessionRoom(code)
			effects = append(effects,
				effect{kind: effectEmitRoom, room: room, event: "participant:left", payload: participant},
				effect{kind: effectLeaveUser, userID: userID, room: room},
			)
		}

		effects = append(effects, effect{kind: effectUnbindSocket, socketID: socketID})
		return nil
	})
	if err != nil {
		return DisconnectOutput{}, err
	}

	s.dispatch(ctx, effects)
	return out, nil
}

func (s *Service) UserIDBySocket(ctx context.Context, socketID string) (string, bool) {
	_ = ctx
	var userID string
	err := s.repo.View(func(st *store.State) error {
		userID = st.SocketToUser[socketID]
		return nil
	})
	return userID, err == nil && userID != ""
}

func (s *Service) now() time.Time {
	return s.clock.Now().UTC()
}

func (s *Service) dispatch(ctx context.Context, effects []effect) {
	for _, item := range effects {
		switch item.kind {
		case effectBindUserSocket:
			_ = s.realtime.BindUserSocket(ctx, item.userID, item.socketID)
		case effectUnbindSocket:
			_ = s.realtime.UnbindSocket(ctx, item.socketID)
		case effectJoinUser:
			_ = s.realtime.JoinUser(ctx, item.userID, item.room)
		case effectLeaveUser:
			_ = s.realtime.LeaveUser(ctx, item.userID, item.room)
		case effectEmitUser:
			_ = s.realtime.EmitToUser(ctx, item.userID, item.event, item.payload)
		case effectEmitRoom:
			_ = s.realtime.EmitToRoom(ctx, item.room, item.event, item.payload)
		case effectEmitAll:
			_ = s.realtime.EmitAll(ctx, item.event, item.payload)
		}
	}
}

func statusAfterConfirmation(approved bool) domain.SupportStatus {
	if approved {
		return domain.StatusActive
	}
	return domain.StatusRejected
}

func buildBootstrap(st *store.State, userID string) Bootstrap {
	user := st.Users[userID]
	tickets := make([]domain.SupportTicket, 0)
	sessions := make([]domain.SupportSession, 0)

	for _, ticket := range st.Tickets {
		if domain.IsTerminalStatus(ticket.Status) {
			continue
		}
		if ticket.RequesterID == userID || ticket.AgentID == userID {
			tickets = append(tickets, ticket)
		}
	}

	for _, session := range st.Sessions {
		if domain.IsTerminalStatus(session.Status) {
			continue
		}
		if isSessionParticipant(session, userID) || session.RequesterID == userID || session.AgentID == userID {
			sessions = append(sessions, session)
		}
	}

	sort.Slice(tickets, func(i, j int) bool { return tickets[i].CreatedAt.Before(tickets[j].CreatedAt) })
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].CreatedAt.Before(sessions[j].CreatedAt) })

	return Bootstrap{
		User:     user,
		Agents:   listOnlineAgents(st),
		Tickets:  tickets,
		Sessions: sessions,
	}
}

func listOnlineAgents(st *store.State) []domain.SupportUser {
	agents := make([]domain.SupportUser, 0)
	for _, user := range st.Users {
		if user.Online && user.HasPermission(domain.PermissionAgent) {
			agents = append(agents, user)
		}
	}
	sort.Slice(agents, func(i, j int) bool { return agents[i].Name < agents[j].Name })
	return agents
}

func requireActiveParticipant(st *store.State, sessionCode string, userID string) (domain.SupportSession, error) {
	session, ok := st.Sessions[sessionCode]
	if !ok {
		return domain.SupportSession{}, domain.NotFound("sessao nao encontrada", map[string]any{"sessionCode": sessionCode})
	}
	if session.Status != domain.StatusActive {
		return domain.SupportSession{}, domain.InvalidState("evento exige sessao ativa", map[string]any{"status": session.Status})
	}
	participant, ok := session.Participants[userID]
	if !ok {
		return domain.SupportSession{}, domain.Forbidden("usuario nao participa da sessao", map[string]any{"userId": userID})
	}
	if !participant.Connected {
		return domain.SupportSession{}, domain.Forbidden("participante desconectado da sessao", map[string]any{"userId": userID})
	}
	return session, nil
}

func isSessionParticipant(session domain.SupportSession, userID string) bool {
	if session.RequesterID == userID || session.AgentID == userID {
		return true
	}
	if session.Participants == nil {
		return false
	}
	_, ok := session.Participants[userID]
	return ok
}

func appendSessionFinishedEffects(effects []effect, session domain.SupportSession, ticket domain.SupportTicket, reason string) []effect {
	payload := map[string]any{
		"ticket":  ticket,
		"session": session,
		"reason":  reason,
	}
	effects = append(effects, effect{kind: effectEmitRoom, room: domain.SessionRoom(session.Code), event: "session:finished", payload: payload})
	if session.RequesterID != "" {
		effects = append(effects, effect{kind: effectEmitUser, userID: session.RequesterID, event: "session:finished", payload: payload})
	}
	if session.AgentID != "" && session.AgentID != session.RequesterID {
		effects = append(effects, effect{kind: effectEmitUser, userID: session.AgentID, event: "session:finished", payload: payload})
	}
	return effects
}

func appendLeaveParticipantsEffects(effects []effect, session domain.SupportSession) []effect {
	for userID := range session.Participants {
		effects = append(effects, effect{kind: effectLeaveUser, userID: userID, room: domain.SessionRoom(session.Code)})
	}
	return effects
}

func finishSession(st *store.State, ticket *domain.SupportTicket, session *domain.SupportSession, now time.Time, reason string, actorID string, trace string) {
	session.Status = domain.StatusFinished
	session.FinishedAt = &now
	session.FinishReason = reason
	session.UpdatedAt = now
	session.NoAssistedExpiresAt = nil

	ticket.Status = domain.StatusFinished
	ticket.FinishedAt = &now
	ticket.FinishReason = reason
	ticket.UpdatedAt = now

	session.Logs = append(session.Logs, newLog(st, session.Code, actorID, "session_finished", "Sessao finalizada", trace, map[string]any{"reason": reason}, now))
}

func newLog(st *store.State, sessionCode string, actorID string, kind string, message string, trace string, data map[string]any, now time.Time) domain.SupportLogEntry {
	return domain.SupportLogEntry{
		ID:             st.NextID("log"),
		SessionCode:    sessionCode,
		ActorID:        actorID,
		Type:           kind,
		Message:        message,
		Data:           cloneMap(data),
		OperationTrace: trace,
		CreatedAt:      now,
	}
}

func cloneStrings(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	out := make([]string, len(in))
	copy(out, in)
	return out
}

func cloneMap(in map[string]any) map[string]any {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}
