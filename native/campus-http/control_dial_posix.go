//go:build linux || darwin

package main

import (
	"context"
	"errors"
	"net"
)

// The native public control lane is Windows-only. Other hosts use Node HTTPS.
func controlDial(context.Context, string, string) (net.Conn, error) {
	return nil, errors.New("PLATFORM_UNSUPPORTED")
}
