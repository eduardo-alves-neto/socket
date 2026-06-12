package socketio

import (
	"encoding/json"

	sio "github.com/doquangtan/socketio/v4"

	"remote-support/internal/domain"
)

type envelope struct {
	OperationTrace string          `json:"operationTrace"`
	Data           json.RawMessage `json:"data,omitempty"`
}

func decodeEnvelope(event *sio.EventPayload, out any) (string, error) {
	if len(event.Data) == 0 {
		return "", domain.InvalidPayload("envelope ausente", nil)
	}

	raw, err := json.Marshal(event.Data[0])
	if err != nil {
		return "", domain.InvalidPayload("envelope invalido", err.Error())
	}

	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return "", domain.InvalidPayload("envelope invalido", err.Error())
	}
	if env.OperationTrace == "" {
		return "", domain.InvalidPayload("operationTrace e obrigatorio", nil)
	}

	if out == nil {
		return env.OperationTrace, nil
	}
	if len(env.Data) == 0 || string(env.Data) == "null" {
		return "", domain.InvalidPayload("data e obrigatorio para este evento", nil)
	}
	if err := json.Unmarshal(env.Data, out); err != nil {
		return "", domain.InvalidPayload("data invalido", err.Error())
	}

	return env.OperationTrace, nil
}

type registerPayload struct {
	UserID      string   `json:"userId"`
	Name        string   `json:"name"`
	Roles       []string `json:"roles"`
	Permissions []string `json:"permissions"`
}

type createTicketPayload struct {
	AgentID string `json:"agentId"`
	Mode    string `json:"mode"`
}

type acceptTicketPayload struct {
	TicketID string `json:"ticketId"`
}

type confirmSessionPayload struct {
	SessionCode string `json:"sessionCode"`
	Approved    *bool  `json:"approved"`
}

type finishSessionPayload struct {
	SessionCode string `json:"sessionCode"`
	Reason      string `json:"reason"`
}

type sessionOnlyPayload struct {
	SessionCode string `json:"sessionCode"`
}

type presencePayload struct {
	SessionCode    string         `json:"sessionCode"`
	Route          string         `json:"route"`
	CursorX        *float64       `json:"cursorX"`
	CursorY        *float64       `json:"cursorY"`
	ScrollX        *float64       `json:"scrollX"`
	ScrollY        *float64       `json:"scrollY"`
	FocusedElement string         `json:"focusedElement"`
	State          map[string]any `json:"state"`
}

type cobrowsingPayload struct {
	SessionCode string         `json:"sessionCode"`
	Type        string         `json:"type"`
	Payload     map[string]any `json:"payload"`
}

func (p presencePayload) toDomain() domain.PresenceState {
	return domain.PresenceState{
		Route:          p.Route,
		CursorX:        p.CursorX,
		CursorY:        p.CursorY,
		ScrollX:        p.ScrollX,
		ScrollY:        p.ScrollY,
		FocusedElement: p.FocusedElement,
		State:          p.State,
	}
}
