package store

import (
	"fmt"

	"remote-support/internal/domain"
)

type Repository interface {
	View(func(*State) error) error
	Update(func(*State) error) error
}

// State representa o banco em memoria do MVP.
// Ele deve ser acessado apenas dentro de Repository.View/Update, que aplicam lock.
type State struct {
	Users        map[string]domain.SupportUser
	SocketToUser map[string]string
	Tickets      map[string]domain.SupportTicket
	Sessions     map[string]domain.SupportSession
	Sequence     uint64
}

func NewState() State {
	return State{
		Users:        make(map[string]domain.SupportUser),
		SocketToUser: make(map[string]string),
		Tickets:      make(map[string]domain.SupportTicket),
		Sessions:     make(map[string]domain.SupportSession),
	}
}

func (s *State) NextID(prefix string) string {
	s.Sequence++
	return fmt.Sprintf("%s-%06d", prefix, s.Sequence)
}

func (s *State) NextSessionCode() string {
	s.Sequence++
	return fmt.Sprintf("RS-%06d", s.Sequence)
}
