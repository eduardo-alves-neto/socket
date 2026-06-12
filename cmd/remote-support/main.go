package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"remote-support/internal/app"
	"remote-support/internal/config"
)

func main() {
	cfg := config.Default()
	if port := os.Getenv("PORT"); port != "" {
		cfg.Addr = ":" + port
	}

	application := app.New(cfg)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go application.Service.RunExpirer(ctx)

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           application.Handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		log.Printf("remote support ouvindo em %s, namespace %s, path %s", cfg.Addr, cfg.Namespace, cfg.SocketPath)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("erro ao iniciar servidor: %v", err)
		}
	}()

	<-ctx.Done()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("erro ao finalizar servidor: %v", err)
	}
	application.Socket.Close()
}
