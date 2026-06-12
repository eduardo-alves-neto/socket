package permissions

import (
	"reflect"
	"testing"

	"remote-support/internal/domain"
)

func TestResolvePermissionsFromRolesAndDirectPermissions(t *testing.T) {
	got := Resolve(
		[]string{"agent", "user"},
		[]string{"custom.permission", domain.PermissionAgent},
	)

	want := []string{
		"custom.permission",
		domain.PermissionAgent,
		domain.PermissionRequest,
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("permissoes = %#v, esperado %#v", got, want)
	}
}
