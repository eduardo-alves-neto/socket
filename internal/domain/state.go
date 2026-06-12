package domain

type SupportStatus string

const (
	StatusRequested           SupportStatus = "requested"
	StatusWaitingUserApproval SupportStatus = "waiting_user_approval"
	StatusActive              SupportStatus = "active"
	StatusFinished            SupportStatus = "finished"
	StatusRejected            SupportStatus = "rejected"
	StatusExpired             SupportStatus = "expired"
)

func IsTerminalStatus(status SupportStatus) bool {
	switch status {
	case StatusFinished, StatusRejected, StatusExpired:
		return true
	default:
		return false
	}
}

// CanTransition documenta a maquina de estados do MVP em um unico ponto.
// Isso evita regras duplicadas entre aceite, confirmacao, finalizacao e TTL.
func CanTransition(from SupportStatus, to SupportStatus) bool {
	switch from {
	case StatusRequested:
		return to == StatusWaitingUserApproval || to == StatusRejected || to == StatusExpired
	case StatusWaitingUserApproval:
		return to == StatusActive || to == StatusRejected || to == StatusExpired
	case StatusActive:
		return to == StatusFinished
	default:
		return false
	}
}

func Transition(from SupportStatus, to SupportStatus) error {
	if CanTransition(from, to) {
		return nil
	}
	return InvalidState("transicao de estado invalida", map[string]any{
		"from": from,
		"to":   to,
	})
}
