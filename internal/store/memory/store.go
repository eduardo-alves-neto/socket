package memory

import (
	"sync"

	"remote-support/internal/store"
)

// Store usa RWMutex para proteger os mapas em memoria.
// View permite leituras concorrentes; Update serializa escrita e leitura mutavel.
type Store struct {
	mu    sync.RWMutex
	state store.State
}

func New() *Store {
	return &Store{state: store.NewState()}
}

func (s *Store) View(fn func(*store.State) error) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return fn(&s.state)
}

func (s *Store) Update(fn func(*store.State) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return fn(&s.state)
}
