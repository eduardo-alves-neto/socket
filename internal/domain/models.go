package domain

import "time"

const (
	PermissionRequest = "remote-support.request"
	PermissionAgent   = "remote-support.agent"
)

type SessionMode string

const (
	SessionModeAssisted SessionMode = "assisted"
	SessionModeShared   SessionMode = "shared"
)

func IsValidSessionMode(mode SessionMode) bool {
	return mode == SessionModeAssisted || mode == SessionModeShared
}

type ParticipantRole string

const (
	ParticipantRequester ParticipantRole = "requester"
	ParticipantAgent     ParticipantRole = "agent"
)

type SupportUser struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Roles       []string  `json:"roles"`
	Permissions []string  `json:"permissions"`
	SocketID    string    `json:"socketId,omitempty"`
	Online      bool      `json:"online"`
	RegisteredAt time.Time `json:"registeredAt"`
	LastSeenAt  time.Time `json:"lastSeenAt"`
}

func (u SupportUser) HasPermission(permission string) bool {
	for _, item := range u.Permissions {
		if item == permission {
			return true
		}
	}
	return false
}

type SupportTicket struct {
	ID                string        `json:"id"`
	SessionCode       string        `json:"sessionCode"`
	RequesterID       string        `json:"requesterId"`
	AgentID           string        `json:"agentId,omitempty"`
	Mode              SessionMode   `json:"mode"`
	Status            SupportStatus `json:"status"`
	CreatedAt         time.Time     `json:"createdAt"`
	UpdatedAt         time.Time     `json:"updatedAt"`
	ExpiresAt         time.Time     `json:"expiresAt"`
	AcceptedAt        *time.Time    `json:"acceptedAt,omitempty"`
	ApprovalExpiresAt *time.Time    `json:"approvalExpiresAt,omitempty"`
	FinishedAt        *time.Time    `json:"finishedAt,omitempty"`
	FinishReason      string        `json:"finishReason,omitempty"`
}

type SupportSession struct {
	Code                 string                        `json:"code"`
	TicketID             string                        `json:"ticketId"`
	RequesterID          string                        `json:"requesterId"`
	AgentID              string                        `json:"agentId,omitempty"`
	Mode                 SessionMode                   `json:"mode"`
	Status               SupportStatus                 `json:"status"`
	Participants         map[string]SupportParticipant `json:"participants"`
	Presence             map[string]PresenceState       `json:"presence"`
	CobrowsingEvents     []CobrowsingEvent             `json:"cobrowsingEvents"`
	Logs                 []SupportLogEntry             `json:"logs"`
	CreatedAt            time.Time                     `json:"createdAt"`
	UpdatedAt            time.Time                     `json:"updatedAt"`
	AcceptedAt           *time.Time                    `json:"acceptedAt,omitempty"`
	ApprovalExpiresAt    *time.Time                    `json:"approvalExpiresAt,omitempty"`
	ActiveAt             *time.Time                    `json:"activeAt,omitempty"`
	FinishedAt           *time.Time                    `json:"finishedAt,omitempty"`
	FinishReason         string                        `json:"finishReason,omitempty"`
	NoAssistedExpiresAt  *time.Time                    `json:"noAssistedExpiresAt,omitempty"`
}

type SupportParticipant struct {
	UserID          string          `json:"userId"`
	SocketID        string          `json:"socketId,omitempty"`
	Role            ParticipantRole `json:"role"`
	Connected       bool            `json:"connected"`
	JoinedAt        time.Time       `json:"joinedAt"`
	LeftAt          *time.Time      `json:"leftAt,omitempty"`
	LastHeartbeatAt time.Time       `json:"lastHeartbeatAt"`
}

type SupportLogEntry struct {
	ID             string         `json:"id"`
	SessionCode    string         `json:"sessionCode"`
	ActorID        string         `json:"actorId,omitempty"`
	Type           string         `json:"type"`
	Message        string         `json:"message"`
	Data           map[string]any `json:"data,omitempty"`
	OperationTrace string         `json:"operationTrace,omitempty"`
	CreatedAt      time.Time      `json:"createdAt"`
}

type PresenceState struct {
	SessionCode    string         `json:"sessionCode"`
	UserID         string         `json:"userId"`
	Route          string         `json:"route,omitempty"`
	CursorX        *float64       `json:"cursorX,omitempty"`
	CursorY        *float64       `json:"cursorY,omitempty"`
	ScrollX        *float64       `json:"scrollX,omitempty"`
	ScrollY        *float64       `json:"scrollY,omitempty"`
	FocusedElement string         `json:"focusedElement,omitempty"`
	State          map[string]any `json:"state,omitempty"`
	UpdatedAt      time.Time      `json:"updatedAt"`
}

type CobrowsingEvent struct {
	ID             string         `json:"id"`
	SessionCode    string         `json:"sessionCode"`
	UserID         string         `json:"userId"`
	Type           string         `json:"type"`
	Payload        map[string]any `json:"payload,omitempty"`
	OperationTrace string         `json:"operationTrace,omitempty"`
	CreatedAt      time.Time      `json:"createdAt"`
}

func SessionRoom(sessionCode string) string {
	return "session:" + sessionCode
}
