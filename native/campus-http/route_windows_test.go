//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"syscall"
	"testing"
	"time"
)

func TestWindowsABI(t *testing.T) {
	if !windowsABIValid() {
		t.Fatal("Windows SDK layout mismatch")
	}
}

func TestWindowsControlDoesNotBindPhysicalInterface(t *testing.T) {
	d := windowsDialer(route{Index: 999999}, false)
	if d.Control != nil {
		t.Fatal("Portal control must use the system route")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, bound, err := windowsSocketDial(ctx, d, listener.Addr().String(), false)
	if err != nil || bound {
		t.Fatalf("default route failed: bound=%v err=%v", bound, err)
	}
	conn.Close()
}

func TestWindowsCampusBindingFailureFallsBackBeforeSending(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	attempts := 0
	d := net.Dialer{Control: func(_, _ string, _ syscall.RawConn) error {
		attempts++
		return errors.New("PHYSICAL_BIND_DENIED")
	}}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, bound, err := windowsSocketDial(ctx, d, listener.Addr().String(), true)
	if err != nil || bound || attempts != 1 {
		t.Fatalf("fallback failed: attempts=%d bound=%v err=%v", attempts, bound, err)
	}
	defer conn.Close()
	peer, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	peer.SetReadDeadline(time.Now().Add(20 * time.Millisecond))
	var b [1]byte
	if n, _ := peer.Read(b[:]); n != 0 {
		t.Fatal("dial fallback sent bytes before TLS/authentication")
	}
}

// Reads current IPHelper tables only, never opens a network socket.
func TestWindowsRouteReadOnly(t *testing.T) {
	r, e := currentRoute()
	if e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(map[string]any{"schema": 1, "physicalRoute": r, "socketOpened": false})
	fmt.Println(string(b))
}
