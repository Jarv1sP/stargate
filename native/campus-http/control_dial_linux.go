//go:build linux

package main

import (
	"context"
	"errors"
	"net"
)

// The Linux WSL process never takes the public control lane itself.
func controlDial(context.Context, string, string) (net.Conn, error) {
	return nil, errors.New("PLATFORM_UNSUPPORTED")
}
