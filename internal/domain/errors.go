package domain

import "errors"

type ErrorCode string

const (
	ErrorInvalidPayload ErrorCode = "INVALID_PAYLOAD"
	ErrorInvalidState   ErrorCode = "INVALID_STATE"
	ErrorForbidden      ErrorCode = "FORBIDDEN"
	ErrorNotFound       ErrorCode = "NOT_FOUND"
	ErrorExpired        ErrorCode = "EXPIRED"
	ErrorConflict       ErrorCode = "CONFLICT"
	ErrorInternal       ErrorCode = "INTERNAL"
)

// AppError e o erro de dominio convertido diretamente para o formato de ack.
// Ele evita strings soltas espalhadas pelo codigo e deixa os testes previsiveis.
type AppError struct {
	Code    ErrorCode
	Message string
	Detail  any
}

func (e *AppError) Error() string {
	if e == nil {
		return ""
	}
	return string(e.Code) + ": " + e.Message
}

func NewError(code ErrorCode, message string, detail any) *AppError {
	return &AppError{Code: code, Message: message, Detail: detail}
}

func InvalidPayload(message string, detail any) *AppError {
	return NewError(ErrorInvalidPayload, message, detail)
}

func InvalidState(message string, detail any) *AppError {
	return NewError(ErrorInvalidState, message, detail)
}

func Forbidden(message string, detail any) *AppError {
	return NewError(ErrorForbidden, message, detail)
}

func NotFound(message string, detail any) *AppError {
	return NewError(ErrorNotFound, message, detail)
}

func Expired(message string, detail any) *AppError {
	return NewError(ErrorExpired, message, detail)
}

func Conflict(message string, detail any) *AppError {
	return NewError(ErrorConflict, message, detail)
}

func Internal(message string, detail any) *AppError {
	return NewError(ErrorInternal, message, detail)
}

func AsAppError(err error) *AppError {
	if err == nil {
		return nil
	}

	var appErr *AppError
	if errors.As(err, &appErr) {
		return appErr
	}

	return Internal("erro interno", err.Error())
}
