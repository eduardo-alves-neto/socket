package socketio

import "remote-support/internal/domain"

func SessionRoom(sessionCode string) string {
	return domain.SessionRoom(sessionCode)
}
