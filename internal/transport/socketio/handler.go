package socketio

import (
	"context"
	"net/http"

	sio "github.com/doquangtan/socketio/v4"

	"remote-support/internal/config"
	"remote-support/internal/domain"
	"remote-support/internal/service"
)

type Handler struct {
	io      *sio.Io
	service *service.Service
	gateway *Gateway
}

func NewHandler(cfg config.Config, supportService *service.Service, gateway *Gateway) *Handler {
	io := sio.New()
	namespace := io.Of(cfg.Namespace)

	h := &Handler{
		io:      io,
		service: supportService,
		gateway: gateway,
	}

	gateway.AttachNamespace(namespace)
	namespace.OnConnection(h.onConnection)
	return h
}

func (h *Handler) HTTPHandler() http.Handler {
	return h.io.HttpHandler()
}

func (h *Handler) Close() {
	h.io.Close()
}

func (h *Handler) onConnection(socket *sio.Socket) {
	h.gateway.TrackSocket(socket)

	socket.On("disconnect", func(event *sio.EventPayload) {
		_, _ = h.service.DisconnectSocket(context.Background(), socket.Id)
		h.gateway.ForgetSocket(socket.Id)
	})

	socket.On("support:register", h.withAck(socket, func(ctx context.Context, event *sio.EventPayload) (any, error) {
		var payload registerPayload
		_, err := decodeEnvelope(event, &payload)
		if err != nil {
			return nil, err
		}

		return h.service.Register(ctx, service.RegisterInput{
			SocketID:    socket.Id,
			UserID:      payload.UserID,
			Name:        payload.Name,
			Roles:       payload.Roles,
			Permissions: payload.Permissions,
		})
	}))

	socket.On("support:agents:list", h.withAck(socket, func(ctx context.Context, event *sio.EventPayload) (any, error) {
		if _, err := decodeEnvelope(event, nil); err != nil {
			return nil, err
		}
		userID, err := h.requireRegistered(ctx, socket.Id)
		if err != nil {
			return nil, err
		}
		return h.service.ListAgents(ctx, userID)
	}))

	socket.On("ticket:create", h.withAck(socket, func(ctx context.Context, event *sio.EventPayload) (any, error) {
		var payload createTicketPayload
		trace, err := decodeEnvelope(event, &payload)
		if err != nil {
			return nil, err
		}
		userID, err := h.requireRegistered(ctx, socket.Id)
		if err != nil {
			return nil, err
		}
		return h.service.CreateTicket(ctx, service.CreateTicketInput{
			RequesterID:    userID,
			AgentID:        payload.AgentID,
			Mode:           domain.SessionMode(payload.Mode),
			OperationTrace: trace,
		})
	}))

	socket.On("ticket:accept", h.withAck(socket, func(ctx context.Context, event *sio.EventPayload) (any, error) {
		var payload acceptTicketPayload
		trace, err := decodeEnvelope(event, &payload)
		if err != nil {
			return nil, err
		}
		userID, err := h.requireRegistered(ctx, socket.Id)
		if err != nil {
			return nil, err
		}
		return h.service.AcceptTicket(ctx, service.AcceptTicketInput{
			AgentID:        userID,
			TicketID:       payload.TicketID,
			OperationTrace: trace,
		})
	}))

	socket.On("session:confirm", h.withAck(socket, func(ctx context.Context, event *sio.EventPayload) (any, error) {
		var payload confirmSessionPayload
		trace, err := decodeEnvelope(event, &payload)
		if err != nil {
			return nil, err
		}
		if payload.Approved == nil {
			return nil, domain.InvalidPayload("approved e obrigatorio", nil)
		}
		userID, err := h.requireRegistered(ctx, socket.Id)
		if err != nil {
			return nil, err
		}
		return h.service.ConfirmSession(ctx, service.ConfirmSessionInput{
			UserID:         userID,
			SessionCode:    payload.SessionCode,
			Approved:       *payload.Approved,
			OperationTrace: trace,
		})
	}))

	socket.On("session:finish", h.withAck(socket, func(ctx context.Context, event *sio.EventPayload) (any, error) {
		var payload finishSessionPayload
		trace, err := decodeEnvelope(event, &payload)
		if err != nil {
			return nil, err
		}
		userID, err := h.requireRegistered(ctx, socket.Id)
		if err != nil {
			return nil, err
		}
		return h.service.FinishSession(ctx, service.FinishSessionInput{
			UserID:         userID,
			SessionCode:    payload.SessionCode,
			Reason:         payload.Reason,
			OperationTrace: trace,
		})
	}))

	socket.On("session:heartbeat", h.withAck(socket, func(ctx context.Context, event *sio.EventPayload) (any, error) {
		var payload sessionOnlyPayload
		if _, err := decodeEnvelope(event, &payload); err != nil {
			return nil, err
		}
		userID, err := h.requireRegistered(ctx, socket.Id)
		if err != nil {
			return nil, err
		}
		return h.service.Heartbeat(ctx, service.HeartbeatInput{UserID: userID, SessionCode: payload.SessionCode})
	}))

	socket.On("presence:update", h.withAck(socket, func(ctx context.Context, event *sio.EventPayload) (any, error) {
		var payload presencePayload
		if _, err := decodeEnvelope(event, &payload); err != nil {
			return nil, err
		}
		userID, err := h.requireRegistered(ctx, socket.Id)
		if err != nil {
			return nil, err
		}
		return h.service.UpdatePresence(ctx, service.UpdatePresenceInput{
			UserID:      userID,
			SessionCode: payload.SessionCode,
			Presence:    payload.toDomain(),
		})
	}))

	socket.On("cobrowsing:event", h.withAck(socket, func(ctx context.Context, event *sio.EventPayload) (any, error) {
		var payload cobrowsingPayload
		trace, err := decodeEnvelope(event, &payload)
		if err != nil {
			return nil, err
		}
		userID, err := h.requireRegistered(ctx, socket.Id)
		if err != nil {
			return nil, err
		}
		return h.service.CobrowsingEvent(ctx, service.CobrowsingEventInput{
			UserID:         userID,
			SessionCode:    payload.SessionCode,
			Type:           payload.Type,
			Payload:        payload.Payload,
			OperationTrace: trace,
		})
	}))
}

func (h *Handler) withAck(_ *sio.Socket, fn func(context.Context, *sio.EventPayload) (any, error)) func(*sio.EventPayload) {
	return func(event *sio.EventPayload) {
		ctx := context.Background()
		data, err := fn(ctx, event)
		if event.Ack == nil {
			return
		}
		if err != nil {
			event.Ack(ackError(err))
			return
		}
		event.Ack(ackOK(data))
	}
}

func (h *Handler) requireRegistered(ctx context.Context, socketID string) (string, error) {
	userID, ok := h.service.UserIDBySocket(ctx, socketID)
	if !ok {
		return "", domain.Forbidden("socket ainda nao registrado em support:register", nil)
	}
	return userID, nil
}
