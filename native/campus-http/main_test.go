package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func certificate(t *testing.T) (tls.Certificate, *x509.Certificate) {
	t.Helper()
	pub, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: "campus.invalid"}, DNSNames: []string{"campus.invalid"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IsCA: true, BasicConstraintsValid: true}
	der, e := x509.CreateCertificate(rand.Reader, template, template, pub, key)
	if e != nil {
		t.Fatal(e)
	}
	cert, e := x509.ParseCertificate(der)
	if e != nil {
		t.Fatal(e)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, cert
}
func fixture(t *testing.T, handler http.HandlerFunc) (*session, grant, *httptest.Server, *atomic.Int64) {
	t.Helper()
	cert, leaf := certificate(t)
	pool := x509.NewCertPool()
	pool.AddCert(leaf)
	connections := &atomic.Int64{}
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			connections.Add(1)
		}
	}
	server.StartTLS()
	t.Cleanup(server.Close)
	sum := sha256.Sum256(leaf.Raw)
	g := grant{Available: true, Protocol: "personal-file-campus-v1", Kind: "campus-direct", RouteID: "primary", Endpoint: "https://campus.invalid:" + strings.Split(server.Listener.Addr().String(), ":")[1], Pin: hex.EncodeToString(sum[:]), Machine: "fixture", ID: "01234567-1234-4234-8234-012345678901", Ticket: strings.Repeat("t", 32), Expires: time.Now().Unix() + 300, Chunk: chunkLimit, File: fileIdentity{Protocol: 2, Path: "source.bin"}}
	s := &session{roots: pool, routeFn: func() (route, error) {
		return route{Name: "fixture-kernel-interface", Index: 2, Gateway: "01020304", Addresses: "192.0.2.1/24"}, nil
	}, dialFn: func(ctx context.Context, _ route, _ string, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", server.Listener.Addr().String())
	}}
	t.Cleanup(s.close)
	return s, g, server, connections
}
func put(g grant, seq int64, offset int64, body []byte, final bool) frame {
	return frame{Schema: 1, Seq: seq, Op: "put", Grant: g, Offset: offset, Final: &final, BodyBytes: len(body)}
}
func TestRawBytesAndKeepalive(t *testing.T) {
	var stored bytes.Buffer
	requests := 0
	s, g, _, connections := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("t", 32) {
			t.Error("ticket absent")
		}
		body, e := io.ReadAll(r.Body)
		if e != nil {
			t.Error(e)
		}
		stored.Write(body)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true,"result":{"receivedBytes":`+strconv.Itoa(stored.Len())+`}}`)
	})
	first := bytes.Repeat([]byte{0, 255, 42, 13}, chunkLimit/4)
	last := []byte("tail\x00")
	for i, b := range [][]byte{first, last} {
		offset := int64(0)
		if i == 1 {
			offset = int64(len(first))
		}
		r, raw := s.request(put(g, int64(i+1), offset, b, i == 1), b)
		if !r.OK || len(raw) != 0 {
			t.Fatalf("unexpected reply %+v", r)
		}
	}
	if !bytes.Equal(stored.Bytes(), append(first, last...)) || requests != 2 || connections.Load() != 1 {
		t.Fatalf("bytes/reuse requests=%d connections=%d", requests, connections.Load())
	}
}
func TestDownloadFixedIdentityAndRawBound(t *testing.T) {
	all := bytes.Repeat([]byte{93}, chunkLimit+29)
	s, g, _, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
		end := offset + chunkLimit
		if end > len(all) {
			end = len(all)
		}
		metadata, _ := json.Marshal(map[string]any{"protocol": 2, "path": "source.bin", "size": len(all), "offset": offset, "eof": end == len(all)})
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("X-GPUQ-File-Metadata", base64.RawURLEncoding.EncodeToString(metadata))
		w.Write(all[offset:end])
	})
	g.File.Size = int64(len(all))
	var downloaded []byte
	for i, offset := range []int64{0, chunkLimit} {
		r, b := s.request(frame{Schema: 1, Seq: int64(i + 1), Op: "get", Grant: g, Offset: offset}, nil)
		if !r.OK {
			t.Fatalf("%+v", r)
		}
		downloaded = append(downloaded, b...)
	}
	if !bytes.Equal(downloaded, all) {
		t.Fatal("raw full file mismatch")
	}
}
func TestLostAckNeverReplaysOriginalWrite(t *testing.T) {
	requests := 0
	original := []byte("persisted once")
	var stored []byte
	s, g, _, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		stored, _ = io.ReadAll(r.Body)
		c, _, e := w.(http.Hijacker).Hijack()
		if e != nil {
			t.Fatal(e)
		}
		c.Close()
	})
	f := put(g, 1, 0, original, true)
	r, _ := s.request(f, original)
	if r.OK || !r.WriteMayHaveReachedPeer || requests != 1 || !bytes.Equal(stored, original) {
		t.Fatal("lost ACK did not preserve unknown write")
	}
	f.Seq = 2
	again, _ := s.request(f, original)
	if again.Code != "SESSION_STOPPED" || requests != 1 || f.Grant.ID != g.ID {
		t.Fatal("write replayed or identity replaced")
	}
}
func TestTLSVerifiedBeforeTicketOrBody(t *testing.T) {
	for _, which := range []string{"pin", "ca", "name"} {
		t.Run(which, func(t *testing.T) {
			calls := 0
			s, g, _, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) { calls++; io.ReadAll(r.Body) })
			if which == "pin" {
				g.Pin = strings.Repeat("0", 64)
			} else if which == "name" {
				g.Endpoint = strings.Replace(g.Endpoint, "campus.invalid", "different.invalid", 1)
			} else {
				s.roots = x509.NewCertPool()
			}
			r, _ := s.request(put(g, 1, 0, []byte("secret"), true), []byte("secret"))
			if r.OK || calls != 0 || r.WriteMayHaveReachedPeer {
				t.Fatal("unverified peer received request")
			}
			expected := "TLS_PIN_CHANGED"
			if which == "ca" || which == "name" {
				expected = "TLS_CHAIN_OR_NAME"
			}
			if r.Code != expected {
				t.Fatalf("%+v", r)
			}
		})
	}
}

func TestCertificateRotationStopsBeforeNewTicket(t *testing.T) {
	calls := 0
	s, g, server, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Connection", "close")
		io.WriteString(w, `{"ok":true,"result":{}}`)
	})
	first, _ := s.request(put(g, 1, 0, nil, false), nil)
	if !first.OK {
		t.Fatal(first.Code)
	}
	next, leaf := certificate(t)
	s.roots.AddCert(leaf)
	// httptest's TLS listener reads this config on the next handshake; the
	// existing connection explicitly closed after its confirmed response.
	server.TLS.Certificates = []tls.Certificate{next}
	result, _ := s.request(put(g, 2, 0, []byte("next body"), true), []byte("next body"))
	if result.Code != "TLS_PIN_CHANGED" || calls != 1 || result.WriteMayHaveReachedPeer {
		t.Fatal("changed certificate received bearer/body")
	}
}

func TestBindDeniedNeverEscalatesOrFallsBack(t *testing.T) {
	s, g, _, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) { t.Fatal("fallback request reached a peer") })
	attempts := 0
	s.dialFn = func(context.Context, route, string, string) (net.Conn, error) {
		attempts++
		return nil, errors.New("PHYSICAL_BIND_DENIED")
	}
	result, _ := s.request(put(g, 1, 0, nil, true), nil)
	if result.Code != "PHYSICAL_BIND_DENIED" || attempts != 1 || result.WriteMayHaveReachedPeer {
		t.Fatal("bind denial bypassed")
	}
}
func TestChangedDescriptorAndRedirectStop(t *testing.T) {
	for _, change := range []string{"pin", "origin", "redirect"} {
		t.Run(change, func(t *testing.T) {
			calls := 0
			s, g, _, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
				calls++
				io.ReadAll(r.Body)
				if change == "redirect" {
					http.Redirect(w, r, "https://relay.invalid", 302)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, `{"ok":true,"result":{}}`)
			})
			r, _ := s.request(put(g, 1, 0, nil, false), nil)
			if change == "redirect" {
				if r.Code != "HTTP_REJECTED" || calls != 1 {
					t.Fatal("redirect followed")
				}
				return
			}
			if !r.OK {
				t.Fatal(r.Code)
			}
			switch change {
			case "pin":
				g.Pin = strings.Repeat("e", 64)
			case "origin":
				g.Endpoint = "https://other.invalid:18441"
			}
			r, _ = s.request(put(g, 2, 0, nil, true), nil)
			if r.Code != "GRANT_IDENTITY_CHANGED" || calls != 1 {
				t.Fatal("descriptor change permitted bytes")
			}
		})
	}
}
func TestBoundedResponsesAndInvalidMetadata(t *testing.T) {
	for _, kind := range []string{"body", "metadata", "headers"} {
		t.Run(kind, func(t *testing.T) {
			s, g, _, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
				if kind == "headers" {
					w.Header().Set("X-Large", strings.Repeat("x", headerLimit+1))
				}
				w.Header().Set("Content-Type", "application/octet-stream")
				w.Header().Set("X-GPUQ-File-Metadata", base64.RawURLEncoding.EncodeToString([]byte(`{"protocol":2,"path":"foreign","data":"private"}`)))
				if kind == "body" {
					w.Write(bytes.Repeat([]byte("x"), chunkLimit+1))
				} else {
					w.Write([]byte("x"))
				}
			})
			g.File.Size = chunkLimit + 1
			r, _ := s.request(frame{Schema: 1, Seq: 1, Op: "get", Grant: g}, nil)
			if r.OK {
				t.Fatal("invalid response accepted")
			}
		})
	}
}
func TestFrameBoundsNoSecretEcho(t *testing.T) {
	s := &session{routeFn: func() (route, error) { return route{}, errors.New("NO_ROUTE") }}
	var input bytes.Buffer
	binary.Write(&input, binary.BigEndian, uint32(headerLimit+1))
	var output bytes.Buffer
	if run(&input, &output, s) == nil {
		t.Fatal("unbounded frame accepted")
	}
	if bytes.Contains(output.Bytes(), []byte("ticket")) {
		t.Fatal("credential in error")
	}
	var header bytes.Buffer
	binary.Write(&header, binary.BigEndian, uint32(13))
	header.WriteString(`{"schema":1}`)
	if _, _, e := readFrame(&header); e == nil {
		t.Fatal("invalid operation accepted")
	}
}
func TestMainDefaultRoutesAreGenericAndAmbiguityRejects(t *testing.T) {
	head := "Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n"
	line := func(name, metric string) string {
		return name + " 00000000 01020304 0003 0 0 " + metric + " 00000000 0 0 0\n"
	}
	r, e := defaultRoute(head + line("any-kernel-ethernet-name", "50") + line("another-nic", "100"))
	if e != nil || r.Name != "any-kernel-ethernet-name" {
		t.Fatal("default selection")
	}
	if _, e = defaultRoute(head + line("one", "50") + line("two", "50")); e == nil {
		t.Fatal("ambiguous routes selected")
	}
	if _, e = defaultRoute(head); e == nil {
		t.Fatal("no default selected")
	}
	if _, e = defaultRoute(head + "damaged\n"); e == nil {
		t.Fatal("damaged route accepted")
	}
}
