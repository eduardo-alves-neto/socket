package app

import (
	"net/http"

	"remote-support/internal/config"
	"remote-support/internal/service"
	"remote-support/internal/store/memory"
	transportsocketio "remote-support/internal/transport/socketio"
)

type App struct {
	Config  config.Config
	Service *service.Service
	Handler http.Handler
	Socket  *transportsocketio.Handler
}

func New(cfg config.Config) *App {
	repo := memory.New()
	gateway := transportsocketio.NewGateway()
	supportService := service.New(repo, cfg, gateway)
	socketHandler := transportsocketio.NewHandler(cfg, supportService, gateway)

	mux := http.NewServeMux()
	mux.Handle(cfg.SocketPath, socketHandler.HTTPHandler())
	mux.Handle(cfg.SocketPath+"/", socketHandler.HTTPHandler())

	return &App{
		Config:  cfg,
		Service: supportService,
		Handler: mux,
		Socket:  socketHandler,
	}
}
