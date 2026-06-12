package config

import "time"

// Config centraliza valores que normalmente viriam de variaveis de ambiente.
// Manter isso em uma struct facilita ajustar os TTLs nos testes sem usar sleep.
type Config struct {
	Addr             string
	Namespace        string
	SocketPath       string
	TicketTTL        time.Duration
	ApprovalTTL      time.Duration
	NoAssistedTTL    time.Duration
	HeartbeatEvery   time.Duration
	HeartbeatGrace   time.Duration
	TTLCheckInterval time.Duration
}

func Default() Config {
	heartbeatEvery := 30 * time.Second

	return Config{
		Addr:             ":8080",
		Namespace:        "/remote-support",
		SocketPath:       "/v1/remote-support/socket.io",
		TicketTTL:        5 * time.Minute,
		ApprovalTTL:      90 * time.Second,
		NoAssistedTTL:    2 * time.Minute,
		HeartbeatEvery:   heartbeatEvery,
		HeartbeatGrace:   2 * heartbeatEvery,
		TTLCheckInterval: 5 * time.Second,
	}
}
