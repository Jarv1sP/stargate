package main

import (
	"context"
	"errors"
	"net"
	"syscall"
	"testing"
)

func TestDialFailureKeepsSafeCause(t *testing.T) {
	for _, row := range []struct {
		err  error
		want string
	}{
		{&net.DNSError{Err: "private DNS detail", Name: "private.invalid"}, "DNS_FAILED"},
		{context.DeadlineExceeded, "TCP_TIMEOUT"},
		{&net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}, "TCP_REFUSED"},
		{syscall.Errno(10061), "TCP_REFUSED"},
		{syscall.ENETUNREACH, "NETWORK_UNREACHABLE"},
		{errors.New("private address and token"), "PHYSICAL_CONNECT_FAILED"},
	} {
		if got := dialFailure(row.err).Error(); got != row.want {
			t.Fatalf("got %s want %s", got, row.want)
		}
	}
}
