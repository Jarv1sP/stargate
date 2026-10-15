package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestLANPreservesCanonicalTLSNamePinAndGrant(t *testing.T) {
	requests := 0
	s, g, server, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		if !strings.HasPrefix(r.Host, "campus.invalid:") || r.Header.Get("Authorization") != "Bearer "+strings.Repeat("t", 32) {
			t.Error("canonical host or original grant changed")
		}
		raw, _ := io.ReadAll(r.Body)
		if string(raw) != "abc" {
			t.Error("file bytes changed")
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true,"result":{"size":3}}`)
	})
	s.dialFn = func(ctx context.Context, _ route, host, port string) (net.Conn, error) {
		if host != "192.168.50.7" || port != "18445" {
			t.Error("LAN dial target not used")
		}
		return (&net.Dialer{}).DialContext(ctx, "tcp", server.Listener.Addr().String())
	}
	f := put(g, 0, []byte("abc"), true)
	f.DialEndpoint = "https://192.168.50.7:18445"
	out, _ := s.request(f, []byte("abc"))
	if !out.OK || requests != 1 {
		t.Fatalf("LAN TLS failed %+v requests=%d", out, requests)
	}
	f.DialEndpoint = "https://192.168.50.8:18445"
	out, _ = s.request(f, []byte("abc"))
	if out.OK || out.Code != "GRANT_IDENTITY_CHANGED" || requests != 1 {
		t.Fatal("live session accepted changed physical target")
	}
}
func TestLANWrongPinSendsNoBearerOrFileBytes(t *testing.T) {
	requests := 0
	s, g, _, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) { requests++ })
	g.Pin = strings.Repeat("0", 64)
	f := put(g, 0, []byte("secret-file"), true)
	f.DialEndpoint = "https://192.168.50.7:18445"
	out, _ := s.request(f, []byte("secret-file"))
	if out.OK || out.Code != "TLS_PIN_CHANGED" || out.WriteMayHaveReachedPeer || requests != 0 {
		t.Fatalf("pin guard weakened %+v", out)
	}
}
func TestLANProbeDeadlineStopsHangingHairpinTLS(t *testing.T) {
	s, g, _, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("HTTP must not start") })
	var peer net.Conn
	s.dialFn = func(context.Context, route, string, string) (net.Conn, error) {
		a, b := net.Pipe()
		peer = b
		return a, nil
	}
	defer func() {
		if peer != nil {
			peer.Close()
		}
	}()
	started := time.Now()
	out, _ := s.request(frame{Op: "probe", Endpoint: g.Endpoint, Pin: g.Pin, DialEndpoint: "https://192.168.50.7:18445", ProbeTimeoutMs: 100}, nil)
	if out.OK || time.Since(started) > 500*time.Millisecond || out.WriteMayHaveReachedPeer {
		t.Fatalf("bounded anonymous TLS probe failed %+v elapsed=%s", out, time.Since(started))
	}
}
func TestLANDialAndProbeBounds(t *testing.T) {
	s, g, _, _ := fixture(t, func(http.ResponseWriter, *http.Request) {})
	for _, endpoint := range []string{"https://100.64.0.9", "https://127.0.0.1", "https://8.8.8.8", "http://192.168.50.7", "https://user@192.168.50.7", "https://192.168.50.7/path"} {
		f := put(g, 0, nil, true)
		f.DialEndpoint = endpoint
		if validate(f) == nil {
			t.Errorf("accepted unapproved LAN origin %s", endpoint)
		}
	}
	for _, ms := range []int{-1, 2501} {
		f := frame{Op: "probe", Endpoint: g.Endpoint, Pin: g.Pin, ProbeTimeoutMs: ms}
		if validate(f) == nil {
			t.Error("accepted unbounded probe")
		}
	}
	s.dialFn = func(context.Context, route, string, string) (net.Conn, error) {
		return nil, errors.New("PHYSICAL_CONNECT_FAILED")
	}
}
