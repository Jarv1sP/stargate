package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestHandshakeErrorsHaveOnlySafeClassifications(t *testing.T) {
	for _, item := range []struct {
		name string
		err  error
		want string
	}{
		{"eof", io.EOF, "HANDSHAKE_EOF"},
		{"wrapped-eof", fmt.Errorf("private host: %w", io.ErrUnexpectedEOF), "HANDSHAKE_EOF"},
		{"deadline", context.DeadlineExceeded, "HANDSHAKE_TIMEOUT"},
		{"network-deadline", &net.OpError{Op: "private-operation", Err: context.DeadlineExceeded}, "HANDSHAKE_TIMEOUT"},
		{"unknown-ca", x509.UnknownAuthorityError{}, "TLS_CHAIN_OR_NAME"},
		{"wrong-name", x509.HostnameError{Certificate: &x509.Certificate{}, Host: "private-host"}, "TLS_CHAIN_OR_NAME"},
		{"expired", x509.CertificateInvalidError{}, "TLS_CHAIN_OR_NAME"},
		{"tls-verify", &tls.CertificateVerificationError{Err: x509.UnknownAuthorityError{}}, "TLS_CHAIN_OR_NAME"},
		{"other", errors.New("private ticket and certificate details"), "HANDSHAKE_FAILED"},
	} {
		t.Run(item.name, func(t *testing.T) {
			if got := handshakeFailure(item.err).Error(); got != item.want {
				t.Fatalf("classification=%s want=%s", got, item.want)
			}
		})
	}
}

func TestHandshakeEOFCannotSendTicketOrPayload(t *testing.T) {
	requests := 0
	s, g, _, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) { requests++ })
	var observed []byte
	s.dialFn = func(ctx context.Context, _ route, _, _ string) (net.Conn, error) {
		client, peer := net.Pipe()
		go func() {
			defer peer.Close()
			header := make([]byte, 5)
			if _, err := io.ReadFull(peer, header); err != nil {
				return
			}
			body := make([]byte, int(binary.BigEndian.Uint16(header[3:])))
			io.ReadFull(peer, body)
			observed = append(header, body...)
		}()
		return client, nil
	}
	result, raw := s.request(put(g, 1, 0, []byte("fixture-secret-payload"), true), []byte("fixture-secret-payload"))
	if result.Code != "HANDSHAKE_EOF" || result.OK || result.WriteMayHaveReachedPeer || len(raw) != 0 || requests != 0 {
		t.Fatalf("%+v", result)
	}
	if strings.Contains(string(observed), g.Ticket) || strings.Contains(string(observed), "fixture-secret-payload") {
		t.Fatal("TLS failure sent credentials or payload")
	}
	second, _ := s.request(put(g, 2, 0, []byte("fixture-secret-payload"), true), []byte("fixture-secret-payload"))
	if second.Code != "SESSION_STOPPED" {
		t.Fatal("failed handshake was silently replayed")
	}
}

func TestActualHandshakeTimeoutIsNotTrustFailure(t *testing.T) {
	s, g, _, _ := fixture(t, func(http.ResponseWriter, *http.Request) { t.Error("unexpected HTTP request") })
	s.origin, _ = url.Parse(g.Endpoint)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	s.dialFn = func(context.Context, route, string, string) (net.Conn, error) {
		client, peer := net.Pipe()
		go func() { defer peer.Close(); <-ctx.Done() }()
		return client, nil
	}
	if err := s.connect(ctx); err == nil || err.Error() != "HANDSHAKE_TIMEOUT" {
		t.Fatalf("timeout classification=%v", err)
	}
}
