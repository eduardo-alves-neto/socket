package memory

import (
	"sync"
	"testing"

	"remote-support/internal/domain"
	storestate "remote-support/internal/store"
)

func TestStoreConcurrentUpdates(t *testing.T) {
	repo := New()
	const total = 50

	var wg sync.WaitGroup
	for i := 0; i < total; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := repo.Update(func(st *storestate.State) error {
				id := st.NextID("user")
				st.Users[id] = domain.SupportUser{ID: id, Name: id}
				return nil
			})
			if err != nil {
				t.Errorf("Update retornou erro: %v", err)
			}
		}()
	}
	wg.Wait()

	err := repo.View(func(st *storestate.State) error {
		if len(st.Users) != total {
			t.Fatalf("usuarios = %d, esperado %d", len(st.Users), total)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("View retornou erro: %v", err)
	}
}
