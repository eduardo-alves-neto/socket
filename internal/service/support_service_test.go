package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"remote-support/internal/config"
	"remote-support/internal/domain"
	"remote-support/internal/store/memory"
)

type fakeClock struct {
	value time.Time
}

func (f *fakeClock) Now() time.Time {
	return f.value
}

func (f *fakeClock) Add(duration time.Duration) {
	f.value = f.value.Add(duration)
}

type realtimeCall struct {
	Kind     string
	UserID   string
	SocketID string
	Room     string
	Event    string
}

type fakeRealtime struct {
	calls []realtimeCall
}

func (f *fakeRealtime) BindUserSocket(_ context.Context, userID string, socketID string) error {
	f.calls = append(f.calls, realtimeCall{Kind: "bind", UserID: userID, SocketID: socketID})
	return nil
}

func (f *fakeRealtime) UnbindSocket(_ context.Context, socketID string) error {
	f.calls = append(f.calls, realtimeCall{Kind: "unbind", SocketID: socketID})
	return nil
}

func (f *fakeRealtime) JoinUser(_ context.Context, userID string, room string) error {
	f.calls = append(f.calls, realtimeCall{Kind: "join", UserID: userID, Room: room})
	return nil
}

func (f *fakeRealtime) LeaveUser(_ context.Context, userID string, room string) error {
	f.calls = append(f.calls, realtimeCall{Kind: "leave", UserID: userID, Room: room})
	return nil
}

func (f *fakeRealtime) EmitToUser(_ context.Context, userID string, event string, _ any) error {
	f.calls = append(f.calls, realtimeCall{Kind: "emit_user", UserID: userID, Event: event})
	return nil
}

func (f *fakeRealtime) EmitToRoom(_ context.Context, room string, event string, _ any) error {
	f.calls = append(f.calls, realtimeCall{Kind: "emit_room", Room: room, Event: event})
	return nil
}

func (f *fakeRealtime) EmitAll(_ context.Context, event string, _ any) error {
	f.calls = append(f.calls, realtimeCall{Kind: "emit_all", Event: event})
	return nil
}

func (f *fakeRealtime) has(kind string, key string, value string) bool {
	for _, call := range f.calls {
		if call.Kind != kind {
			continue
		}
		switch key {
		case "user":
			if call.UserID == value {
				return true
			}
		case "socket":
			if call.SocketID == value {
				return true
			}
		case "room":
			if call.Room == value {
				return true
			}
		case "event":
			if call.Event == value {
				return true
			}
		}
	}
	return false
}

func newTestService() (*Service, *fakeRealtime, *fakeClock) {
	cfg := config.Default()
	cfg.TTLCheckInterval = time.Second
	cfg.HeartbeatGrace = time.Minute
	clock := &fakeClock{value: time.Date(2026, 6, 12, 12, 0, 0, 0, time.UTC)}
	realtime := &fakeRealtime{}
	svc := New(memory.New(), cfg, realtime, WithClock(clock))
	return svc, realtime, clock
}

func registerPair(t *testing.T, svc *Service) {
	t.Helper()
	ctx := context.Background()

	if _, err := svc.Register(ctx, RegisterInput{
		SocketID: "socket-user",
		UserID:   "user-1",
		Name:     "Usuario",
		Roles:    []string{"user"},
	}); err != nil {
		t.Fatalf("register usuario: %v", err)
	}

	if _, err := svc.Register(ctx, RegisterInput{
		SocketID: "socket-agent",
		UserID:   "agent-1",
		Name:     "Atendente",
		Roles:    []string{"agent"},
	}); err != nil {
		t.Fatalf("register atendente: %v", err)
	}
}

func createAcceptedActiveSession(t *testing.T, svc *Service) CreateTicketOutput {
	t.Helper()
	ctx := context.Background()

	created, err := svc.CreateTicket(ctx, CreateTicketInput{
		RequesterID:    "user-1",
		AgentID:        "agent-1",
		Mode:           domain.SessionModeAssisted,
		OperationTrace: "trace-create",
	})
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}

	if _, err := svc.AcceptTicket(ctx, AcceptTicketInput{
		AgentID:        "agent-1",
		TicketID:       created.Ticket.ID,
		OperationTrace: "trace-accept",
	}); err != nil {
		t.Fatalf("AcceptTicket: %v", err)
	}

	confirmed, err := svc.ConfirmSession(ctx, ConfirmSessionInput{
		UserID:         "user-1",
		SessionCode:    created.Session.Code,
		Approved:       true,
		OperationTrace: "trace-confirm",
	})
	if err != nil {
		t.Fatalf("ConfirmSession: %v", err)
	}

	return CreateTicketOutput{Ticket: confirmed.Ticket, Session: confirmed.Session}
}

func TestRegisterListAgentsAndBootstrap(t *testing.T) {
	svc, realtime, _ := newTestService()
	registerPair(t, svc)

	if !realtime.has("emit_user", "event", "support:bootstrap") {
		t.Fatal("registro deveria emitir support:bootstrap")
	}

	agents, err := svc.ListAgents(context.Background(), "user-1")
	if err != nil {
		t.Fatalf("ListAgents: %v", err)
	}
	if len(agents.Agents) != 1 || agents.Agents[0].ID != "agent-1" {
		t.Fatalf("agents = %#v, esperado agent-1", agents.Agents)
	}
	if !agents.Agents[0].HasPermission(domain.PermissionAgent) {
		t.Fatal("role agent deveria resolver remote-support.agent")
	}
}

func TestTicketAcceptConfirmRoomsPresenceAndCobrowsing(t *testing.T) {
	svc, realtime, _ := newTestService()
	registerPair(t, svc)

	ctx := context.Background()
	created, err := svc.CreateTicket(ctx, CreateTicketInput{
		RequesterID:    "user-1",
		AgentID:        "agent-1",
		Mode:           domain.SessionModeShared,
		OperationTrace: "trace-create",
	})
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	if created.Ticket.Status != domain.StatusRequested {
		t.Fatalf("status inicial = %s", created.Ticket.Status)
	}
	if !realtime.has("emit_user", "event", "ticket:created") {
		t.Fatal("ticket:create deveria notificar o atendente")
	}

	accepted, err := svc.AcceptTicket(ctx, AcceptTicketInput{
		AgentID:        "agent-1",
		TicketID:       created.Ticket.ID,
		OperationTrace: "trace-accept",
	})
	if err != nil {
		t.Fatalf("AcceptTicket: %v", err)
	}
	room := domain.SessionRoom(created.Session.Code)
	if accepted.Session.Status != domain.StatusWaitingUserApproval {
		t.Fatalf("status apos aceite = %s", accepted.Session.Status)
	}
	if !realtime.has("join", "user", "agent-1") || !realtime.has("emit_user", "event", "session:approval_requested") {
		t.Fatal("aceite deveria colocar atendente na sala e pedir aprovacao ao usuario")
	}

	confirmed, err := svc.ConfirmSession(ctx, ConfirmSessionInput{
		UserID:         "user-1",
		SessionCode:    created.Session.Code,
		Approved:       true,
		OperationTrace: "trace-confirm",
	})
	if err != nil {
		t.Fatalf("ConfirmSession: %v", err)
	}
	if confirmed.Session.Status != domain.StatusActive {
		t.Fatalf("status apos confirmacao = %s", confirmed.Session.Status)
	}
	if !realtime.has("join", "user", "user-1") || !realtime.has("emit_room", "event", "session:active") {
		t.Fatal("confirmacao deveria colocar usuario na sala e emitir session:active")
	}

	if _, err := svc.UpdatePresence(ctx, UpdatePresenceInput{
		UserID:      "user-1",
		SessionCode: created.Session.Code,
		Presence:    domain.PresenceState{Route: "/audits/123"},
	}); err != nil {
		t.Fatalf("UpdatePresence: %v", err)
	}
	if !realtime.has("emit_room", "event", "presence:updated") || !realtime.has("emit_room", "room", room) {
		t.Fatal("presenca deveria ser emitida apenas para a sala da sessao")
	}

	if _, err := svc.CobrowsingEvent(ctx, CobrowsingEventInput{
		UserID:         "agent-1",
		SessionCode:    created.Session.Code,
		Type:           "cursor",
		Payload:        map[string]any{"x": 10, "y": 20},
		OperationTrace: "trace-cursor",
	}); err != nil {
		t.Fatalf("CobrowsingEvent: %v", err)
	}
	if !realtime.has("emit_room", "event", "cobrowsing:event_received") {
		t.Fatal("co-browsing deveria ser restrito a sala")
	}
}

func TestInvalidTransitions(t *testing.T) {
	svc, _, _ := newTestService()
	registerPair(t, svc)

	ctx := context.Background()
	created, err := svc.CreateTicket(ctx, CreateTicketInput{
		RequesterID:    "user-1",
		AgentID:        "agent-1",
		Mode:           domain.SessionModeAssisted,
		OperationTrace: "trace-create",
	})
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}

	_, err = svc.FinishSession(ctx, FinishSessionInput{
		UserID:      "user-1",
		SessionCode: created.Session.Code,
	})
	if err == nil {
		t.Fatal("finalizar antes de ativa deveria falhar")
	}
	var appErr *domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != domain.ErrorInvalidState {
		t.Fatalf("erro = %v, esperado INVALID_STATE", err)
	}
}

func TestTTLExpiration(t *testing.T) {
	svc, _, clock := newTestService()
	registerPair(t, svc)
	ctx := context.Background()

	requested, err := svc.CreateTicket(ctx, CreateTicketInput{
		RequesterID:    "user-1",
		AgentID:        "agent-1",
		Mode:           domain.SessionModeAssisted,
		OperationTrace: "trace-create",
	})
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	clock.Add(svc.cfg.TicketTTL + time.Second)
	expired, err := svc.Expire(ctx)
	if err != nil {
		t.Fatalf("Expire ticket: %v", err)
	}
	if len(expired.ExpiredTickets) != 1 || expired.ExpiredTickets[0].ID != requested.Ticket.ID {
		t.Fatalf("ticket expirado = %#v", expired.ExpiredTickets)
	}

	active := createAcceptedActiveSession(t, svc)
	if _, err := svc.DisconnectSocket(ctx, "socket-user"); err != nil {
		t.Fatalf("DisconnectSocket: %v", err)
	}
	clock.Add(svc.cfg.NoAssistedTTL + time.Second)
	closed, err := svc.Expire(ctx)
	if err != nil {
		t.Fatalf("Expire sessao sem usuario: %v", err)
	}
	if len(closed.ClosedSessions) == 0 {
		t.Fatal("sessao sem usuario assistido deveria ser encerrada")
	}
	found := false
	for _, session := range closed.ClosedSessions {
		if session.Code == active.Session.Code && session.Status == domain.StatusFinished {
			found = true
		}
	}
	if !found {
		t.Fatalf("sessao ativa deveria finalizar por abandono: %#v", closed.ClosedSessions)
	}
}

func TestApprovalTTLExpiration(t *testing.T) {
	svc, _, clock := newTestService()
	registerPair(t, svc)
	ctx := context.Background()

	created, err := svc.CreateTicket(ctx, CreateTicketInput{
		RequesterID:    "user-1",
		AgentID:        "agent-1",
		Mode:           domain.SessionModeShared,
		OperationTrace: "trace-create",
	})
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	if _, err := svc.AcceptTicket(ctx, AcceptTicketInput{
		AgentID:        "agent-1",
		TicketID:       created.Ticket.ID,
		OperationTrace: "trace-accept",
	}); err != nil {
		t.Fatalf("AcceptTicket: %v", err)
	}

	clock.Add(svc.cfg.ApprovalTTL + time.Second)
	expired, err := svc.Expire(ctx)
	if err != nil {
		t.Fatalf("Expire approval: %v", err)
	}
	if len(expired.ExpiredTickets) != 1 || expired.ExpiredTickets[0].Status != domain.StatusExpired {
		t.Fatalf("approval deveria expirar chamado: %#v", expired.ExpiredTickets)
	}
}

func TestReconnectRejoinsActiveRooms(t *testing.T) {
	svc, realtime, _ := newTestService()
	registerPair(t, svc)
	ctx := context.Background()
	active := createAcceptedActiveSession(t, svc)
	room := domain.SessionRoom(active.Session.Code)

	if _, err := svc.DisconnectSocket(ctx, "socket-user"); err != nil {
		t.Fatalf("DisconnectSocket: %v", err)
	}
	if !realtime.has("leave", "user", "user-1") {
		t.Fatal("disconnect deveria tirar usuario da sala")
	}

	if _, err := svc.Register(ctx, RegisterInput{
		SocketID: "socket-user-2",
		UserID:   "user-1",
		Name:     "Usuario",
		Roles:    []string{"user"},
	}); err != nil {
		t.Fatalf("reconnect Register: %v", err)
	}

	if !realtime.has("join", "room", room) {
		t.Fatal("reconnect deveria recolocar usuario na sala ativa")
	}
	if !realtime.has("emit_room", "event", "participant:joined") {
		t.Fatal("reconnect deveria emitir participant:joined")
	}
}
