package service

import (
	"context"
	"time"

	"remote-support/internal/domain"
	"remote-support/internal/store"
)

type ExpireOutput struct {
	ExpiredTickets  []domain.SupportTicket  `json:"expiredTickets"`
	ClosedSessions  []domain.SupportSession `json:"closedSessions"`
	StaleParticipants []domain.SupportParticipant `json:"staleParticipants"`
}

func (s *Service) RunExpirer(ctx context.Context) {
	ticker := time.NewTicker(s.cfg.TTLCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_, _ = s.Expire(ctx)
		}
	}
}

func (s *Service) Expire(ctx context.Context) (ExpireOutput, error) {
	now := s.now()
	var out ExpireOutput
	var effects []effect

	err := s.repo.Update(func(st *store.State) error {
		for ticketID, ticket := range st.Tickets {
			if ticket.Status != domain.StatusRequested || now.Before(ticket.ExpiresAt) {
				continue
			}

			if err := expireRequestedTicket(st, &ticket, now, "ticket_ttl"); err != nil {
				return err
			}
			st.Tickets[ticketID] = ticket

			session := st.Sessions[ticket.SessionCode]
			out.ExpiredTickets = append(out.ExpiredTickets, ticket)
			out.ClosedSessions = append(out.ClosedSessions, session)
			effects = appendSessionFinishedEffects(effects, session, ticket, "expired")
		}

		for sessionCode, session := range st.Sessions {
			switch session.Status {
			case domain.StatusWaitingUserApproval:
				if session.ApprovalExpiresAt == nil || now.Before(*session.ApprovalExpiresAt) {
					continue
				}

				ticket := st.Tickets[session.TicketID]
				if err := expireWaitingSession(st, &ticket, &session, now, "approval_ttl"); err != nil {
					return err
				}
				st.Tickets[ticket.ID] = ticket
				st.Sessions[sessionCode] = session
				out.ExpiredTickets = append(out.ExpiredTickets, ticket)
				out.ClosedSessions = append(out.ClosedSessions, session)
				effects = appendSessionFinishedEffects(effects, session, ticket, "expired")

			case domain.StatusActive:
				ticket := st.Tickets[session.TicketID]
				session, staleEffects, staleParticipants := s.markStaleParticipants(session, now)
				effects = append(effects, staleEffects...)
				out.StaleParticipants = append(out.StaleParticipants, staleParticipants...)

				if session.NoAssistedExpiresAt == nil || now.Before(*session.NoAssistedExpiresAt) {
					st.Sessions[sessionCode] = session
					continue
				}

				finishSession(st, &ticket, &session, now, "assisted_user_absent", "", "")
				st.Tickets[ticket.ID] = ticket
				st.Sessions[sessionCode] = session
				out.ClosedSessions = append(out.ClosedSessions, session)
				effects = appendSessionFinishedEffects(effects, session, ticket, "assisted_user_absent")
				effects = appendLeaveParticipantsEffects(effects, session)
			}
		}

		return nil
	})
	if err != nil {
		return ExpireOutput{}, err
	}

	s.dispatch(ctx, effects)
	return out, nil
}

func (s *Service) markStaleParticipants(session domain.SupportSession, now time.Time) (domain.SupportSession, []effect, []domain.SupportParticipant) {
	var effects []effect
	var stale []domain.SupportParticipant

	for userID, participant := range session.Participants {
		if !participant.Connected || participant.LastHeartbeatAt.IsZero() {
			continue
		}
		if now.Sub(participant.LastHeartbeatAt) <= s.cfg.HeartbeatGrace {
			continue
		}

		participant.Connected = false
		participant.LeftAt = &now
		session.Participants[userID] = participant
		session.UpdatedAt = now
		stale = append(stale, participant)

		if session.RequesterID == userID {
			expiresAt := now.Add(s.cfg.NoAssistedTTL)
			session.NoAssistedExpiresAt = &expiresAt
		}

		effects = append(effects,
			effect{kind: effectEmitRoom, room: domain.SessionRoom(session.Code), event: "participant:left", payload: participant},
			effect{kind: effectLeaveUser, userID: userID, room: domain.SessionRoom(session.Code)},
		)
	}

	return session, effects, stale
}

func expireRequestedTicket(st *store.State, ticket *domain.SupportTicket, now time.Time, reason string) error {
	if err := domain.Transition(ticket.Status, domain.StatusExpired); err != nil {
		return err
	}

	session := st.Sessions[ticket.SessionCode]
	if err := domain.Transition(session.Status, domain.StatusExpired); err != nil {
		return err
	}

	ticket.Status = domain.StatusExpired
	ticket.FinishedAt = &now
	ticket.FinishReason = reason
	ticket.UpdatedAt = now

	session.Status = domain.StatusExpired
	session.FinishedAt = &now
	session.FinishReason = reason
	session.UpdatedAt = now
	session.Logs = append(session.Logs, newLog(st, session.Code, "", "session_expired", "Sessao expirada", "", map[string]any{"reason": reason}, now))
	st.Sessions[session.Code] = session
	return nil
}

func expireWaitingSession(st *store.State, ticket *domain.SupportTicket, session *domain.SupportSession, now time.Time, reason string) error {
	if err := domain.Transition(session.Status, domain.StatusExpired); err != nil {
		return err
	}

	ticket.Status = domain.StatusExpired
	ticket.FinishedAt = &now
	ticket.FinishReason = reason
	ticket.UpdatedAt = now

	session.Status = domain.StatusExpired
	session.FinishedAt = &now
	session.FinishReason = reason
	session.UpdatedAt = now
	session.Logs = append(session.Logs, newLog(st, session.Code, "", "session_expired", "Sessao expirada", "", map[string]any{"reason": reason}, now))
	return nil
}
