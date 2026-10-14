package main

import (
	"context"
	"errors"
	"net"
	"syscall"
)

// Preserve safe transport causes without sending a raw address, socket error,
// bearer or OS message over the framed wire. No retry or route change here.
func dialFailure(err error) error {
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return errors.New("DNS_FAILED")
	}
	var network net.Error
	if errors.Is(err, context.DeadlineExceeded) || errors.As(err, &network) && network.Timeout() {
		return errors.New("TCP_TIMEOUT")
	}
	if errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.Errno(10061)) {
		return errors.New("TCP_REFUSED")
	}
	if errors.Is(err, syscall.ENETUNREACH) || errors.Is(err, syscall.EHOSTUNREACH) {
		return errors.New("NETWORK_UNREACHABLE")
	}
	return errors.New("PHYSICAL_CONNECT_FAILED")
}
