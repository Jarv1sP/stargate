package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync/atomic"
	"testing"
)

const busyReceipt = `{"ok":false,"code":"BUSY","reasonCode":"LISTENER_BUSY","retryAfter":2}`

func TestHTTP429NeedsNoReceiptFields(t *testing.T) {
	for _, body := range []string{`{}`, `{"futureField":true}`, `not JSON`} {
		response := &http.Response{StatusCode: 429, Header: http.Header{"Retry-After": {"2"}}}
		if got := admissionBusyDelay(response, []byte(body)); got != 2000 {
			t.Fatalf("delay %d", got)
		}
	}
	response := &http.Response{StatusCode: 503}
	if admissionBusyDelay(response, nil) != 0 {
		t.Fatal("unknown writes must not be replayed")
	}
}
func TestAdmissionBusyKeepsProbePushPullAndDatasetIdentity(t *testing.T) {
	for _, op := range []string{"probe", "put", "get"} {
		t.Run(op, func(t *testing.T) {
			var calls atomic.Int64
			s, g, _, connections := fixture(t, func(w http.ResponseWriter, r *http.Request) {
				io.Copy(io.Discard, r.Body)
				w.Header().Set("Content-Type", "application/json")
				if calls.Add(1) == 1 {
					w.Header().Set("Retry-After", "2")
					w.Header().Set("Connection", "close")
					w.WriteHeader(429)
					io.WriteString(w, busyReceipt)
					return
				}
				if op == "get" {
					metadata, _ := json.Marshal(map[string]any{"protocol": 2, "path": "source.bin", "size": 3, "offset": 0, "eof": true})
					w.Header().Set("Content-Type", "application/octet-stream")
					w.Header().Set("X-GPUQ-File-Metadata", base64.RawURLEncoding.EncodeToString(metadata))
					w.Write([]byte("raw"))
					return
				}
				io.WriteString(w, `{"ok":true,"result":{"offset":3}}`)
			})
			body := []byte("raw")
			f := put(g, 1, 0, body, true)
			if op == "probe" {
				body = nil
				f = frame{Schema: 1, Seq: 1, Op: op, Endpoint: g.Endpoint, Pin: g.Pin, ProbeTimeoutMs: 1000}
			}
			if op == "get" {
				body = nil
				g.File.Size = 3
				f = frame{Schema: 1, Seq: 1, Op: op, Grant: g}
			}
			first, raw := s.request(f, body)
			if first.OK || !first.AdmissionRejected || first.RetryAfterMs != 2000 || first.WriteMayHaveReachedPeer || s.stopped || len(raw) != 0 {
				t.Fatalf("not resumable: %+v", first)
			}
			fixed := s.fixed
			f.Seq++
			second, _ := s.request(f, body)
			if !second.OK || calls.Load() != 2 || connections.Load() != 2 || s.fixed != fixed {
				t.Fatalf("scope changed or refused resume: %+v", second)
			}
		})
	}
}

func TestAdmissionImmediatelyAfterTLSBeforeLargeBody(t *testing.T) {
	var accepted atomic.Int64
	s, g, server, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		data, err := io.ReadAll(r.Body)
		if err != nil || len(data) != personalChunkLimit {
			t.Error("body or ACK changed")
		}
		accepted.Add(1)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true,"result":{"offset":16777216}}`)
	})
	busy, err := tls.Listen("tcp", "127.0.0.1:0", server.TLS)
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, err := busy.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		if err = conn.(*tls.Conn).Handshake(); err != nil {
			return
		}
		io.WriteString(conn, "HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nRetry-After: 2\r\nConnection: close\r\nContent-Length: "+strconv.Itoa(len(busyReceipt))+"\r\n\r\n"+busyReceipt)
	}()
	var dials atomic.Int64
	s.dialFn = func(ctx context.Context, _ route, _, _ string) (net.Conn, error) {
		target := server.Listener.Addr().String()
		if dials.Add(1) == 1 {
			target = busy.Addr().String()
		}
		return (&net.Dialer{}).DialContext(ctx, "tcp", target)
	}
	g.Chunk = personalChunkLimit
	g.MaxChunk = personalChunkLimit
	body := bytes.Repeat([]byte{0x5a}, personalChunkLimit)
	f := put(g, 1, 0, body, true)
	first, _ := s.request(f, body)
	<-done
	if !first.AdmissionRejected || first.RetryAfterMs != 2000 || first.WriteMayHaveReachedPeer || s.stopped {
		t.Fatalf("early BUSY was lost: %+v", first)
	}
	f.Seq++
	second, _ := s.request(f, body)
	if !second.OK || accepted.Load() != 1 {
		t.Fatalf("duplicate or failed write: %+v", second)
	}
}
