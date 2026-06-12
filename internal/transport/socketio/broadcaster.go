package socketio

import (
	"context"
	"log"
	"sync"

	sio "github.com/doquangtan/socketio/v4"
)

// Gateway adapta a interface service.Realtime para Socket.IO.
// O servico conhece apenas userID/sala/evento; este pacote conhece sockets reais.
type Gateway struct {
	mu          sync.RWMutex
	namespace   *sio.Namespace
	sockets     map[string]*sio.Socket
	userSockets map[string]string
}

func NewGateway() *Gateway {
	return &Gateway{
		sockets:     make(map[string]*sio.Socket),
		userSockets: make(map[string]string),
	}
}

func (g *Gateway) AttachNamespace(namespace *sio.Namespace) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.namespace = namespace
}

func (g *Gateway) TrackSocket(socket *sio.Socket) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.sockets[socket.Id] = socket
}

func (g *Gateway) ForgetSocket(socketID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.sockets, socketID)
	for userID, currentSocketID := range g.userSockets {
		if currentSocketID == socketID {
			delete(g.userSockets, userID)
		}
	}
}

func (g *Gateway) BindUserSocket(ctx context.Context, userID string, socketID string) error {
	_ = ctx
	g.mu.Lock()
	defer g.mu.Unlock()
	g.userSockets[userID] = socketID
	return nil
}

func (g *Gateway) UnbindSocket(ctx context.Context, socketID string) error {
	_ = ctx
	g.mu.Lock()
	defer g.mu.Unlock()
	for userID, currentSocketID := range g.userSockets {
		if currentSocketID == socketID {
			delete(g.userSockets, userID)
		}
	}
	return nil
}

func (g *Gateway) JoinUser(ctx context.Context, userID string, room string) error {
	_ = ctx
	socket, ok := g.socketForUser(userID)
	if !ok {
		return nil
	}
	socket.Join(room)
	return nil
}

func (g *Gateway) LeaveUser(ctx context.Context, userID string, room string) error {
	_ = ctx
	socket, ok := g.socketForUser(userID)
	if !ok {
		return nil
	}
	socket.Leave(room)
	return nil
}

func (g *Gateway) EmitToUser(ctx context.Context, userID string, event string, payload any) error {
	_ = ctx
	socket, ok := g.socketForUser(userID)
	if !ok {
		return nil
	}
	return socket.Emit(event, payload)
}

func (g *Gateway) EmitToRoom(ctx context.Context, room string, event string, payload any) error {
	_ = ctx
	namespace := g.currentNamespace()
	if namespace == nil {
		log.Printf("[EmitToRoom] namespace nil — ignorando room=%s event=%s", room, event)
		return nil
	}
	sockets := namespace.To(room).Sockets()
	log.Printf("[EmitToRoom] room=%s event=%s sockets_na_sala=%d", room, event, len(sockets))
	for i, socket := range sockets {
		log.Printf("[EmitToRoom] emitindo para socket[%d] id=%s", i, socket.Id)
		if err := socket.Emit(event, payload); err != nil {
			log.Printf("[EmitToRoom] erro ao emitir para socket[%d] id=%s: %v", i, socket.Id, err)
		} else {
			log.Printf("[EmitToRoom] socket[%d] id=%s ok", i, socket.Id)
		}
	}
	log.Printf("[EmitToRoom] concluido room=%s event=%s", room, event)
	return nil
}

func (g *Gateway) EmitAll(ctx context.Context, event string, payload any) error {
	_ = ctx
	namespace := g.currentNamespace()
	if namespace == nil {
		return nil
	}
	return namespace.Emit(event, payload)
}

func (g *Gateway) socketForUser(userID string) (*sio.Socket, bool) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	socketID, ok := g.userSockets[userID]
	if !ok {
		return nil, false
	}
	socket, ok := g.sockets[socketID]
	return socket, ok
}

func (g *Gateway) currentNamespace() *sio.Namespace {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.namespace
}
