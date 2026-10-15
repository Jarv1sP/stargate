package main

import (
	"context"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func TestTCPRouteProbeSendsNoTLSHTTPOrFileBytes(t *testing.T) {
	reads := make(chan error, 1)
	dials := 0
	s := &session{routeFn: func() (route, error) { return route{Name: "fixture"}, nil },
		dialFn: func(ctx context.Context, _ route, host, port string) (net.Conn, error) {
			dials++
			deadline, ok := ctx.Deadline()
			if host != "campus.invalid" || port != "443" || !ok || time.Until(deadline) > 1500*time.Millisecond {
				t.Error("TCP probe changed target or exceeded its deadline")
			}
			client, peer := net.Pipe()
			go func() { defer peer.Close(); b := make([]byte, 1); _, err := peer.Read(b); reads <- err }()
			return client, nil
		}}
	f := frame{Op: "probe", Endpoint: "https://campus.invalid", Pin: strings.Repeat("a", 64), ProbeTimeoutMs: 1500, TCPOnly: true}
	if err := validate(f); err != nil {
		t.Fatal(err)
	}
	got, raw := s.request(f, nil)
	if !got.OK || len(raw) != 0 || dials != 1 {
		t.Fatalf("TCP probe failed: %+v dials=%d", got, dials)
	}
	if err := <-reads; err != io.EOF {
		t.Fatalf("probe sent bytes instead of closing: %v", err)
	}
}

func TestTCPRouteProbeStopsAtItsDeadline(t *testing.T) {
	s := &session{routeFn: func() (route, error) { return route{}, nil },
		dialFn: func(ctx context.Context, _ route, _, _ string) (net.Conn, error) { <-ctx.Done(); return nil, ctx.Err() }}
	started := time.Now()
	got, _ := s.request(frame{Op: "probe", Endpoint: "https://campus.invalid", Pin: strings.Repeat("a", 64), ProbeTimeoutMs: 25, TCPOnly: true}, nil)
	if got.OK || time.Since(started) > 500*time.Millisecond {
		t.Fatalf("TCP deadline failed: %+v", got)
	}
}
