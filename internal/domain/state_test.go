package domain

import "testing"

func TestSupportStateMachine(t *testing.T) {
	validTransitions := map[SupportStatus][]SupportStatus{
		StatusRequested:           {StatusWaitingUserApproval, StatusRejected, StatusExpired},
		StatusWaitingUserApproval: {StatusActive, StatusRejected, StatusExpired},
		StatusActive:              {StatusFinished},
	}

	allStatuses := []SupportStatus{
		StatusRequested,
		StatusWaitingUserApproval,
		StatusActive,
		StatusFinished,
		StatusRejected,
		StatusExpired,
	}

	for from, validTargets := range validTransitions {
		validSet := make(map[SupportStatus]struct{})
		for _, target := range validTargets {
			validSet[target] = struct{}{}
		}

		for _, to := range allStatuses {
			_, shouldBeValid := validSet[to]
			if CanTransition(from, to) != shouldBeValid {
				t.Fatalf("CanTransition(%s, %s) = %v, esperado %v", from, to, CanTransition(from, to), shouldBeValid)
			}
		}
	}

	for _, terminal := range []SupportStatus{StatusFinished, StatusRejected, StatusExpired} {
		for _, to := range allStatuses {
			if CanTransition(terminal, to) {
				t.Fatalf("estado terminal %s nao deveria transicionar para %s", terminal, to)
			}
		}
	}
}
