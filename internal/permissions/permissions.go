package permissions

import (
	"sort"

	"remote-support/internal/domain"
)

var rolePermissions = map[string][]string{
	"agent":     {domain.PermissionAgent},
	"support":   {domain.PermissionAgent},
	"requester": {domain.PermissionRequest},
	"user":      {domain.PermissionRequest},
}

// Resolve combina permissoes explicitas com permissoes derivadas de roles.
// No MVP o registro e confiavel; em producao essa decisao viria do auth/ACL.
func Resolve(roles []string, direct []string) []string {
	set := make(map[string]struct{})

	for _, permission := range direct {
		if permission != "" {
			set[permission] = struct{}{}
		}
	}

	for _, role := range roles {
		for _, permission := range rolePermissions[role] {
			set[permission] = struct{}{}
		}
	}

	result := make([]string, 0, len(set))
	for permission := range set {
		result = append(result, permission)
	}
	sort.Strings(result)
	return result
}

func Has(permissions []string, expected string) bool {
	for _, permission := range permissions {
		if permission == expected {
			return true
		}
	}
	return false
}
