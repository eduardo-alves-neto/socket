package socketio

import "remote-support/internal/domain"

type AckResponse struct {
	OK    bool      `json:"ok"`
	Data  any       `json:"data,omitempty"`
	Error *AckError `json:"error,omitempty"`
}

type AckError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Detail  any    `json:"detail,omitempty"`
}

func ackOK(data any) AckResponse {
	return AckResponse{OK: true, Data: data}
}

func ackError(err error) AckResponse {
	appErr := domain.AsAppError(err)
	return AckResponse{
		OK: false,
		Error: &AckError{
			Code:    string(appErr.Code),
			Message: appErr.Message,
			Detail:  appErr.Detail,
		},
	}
}
