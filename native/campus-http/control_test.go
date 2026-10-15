package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

func TestControlWriteLostReplyNeverReplays(t *testing.T) {
	var calls atomic.Int64
	s := controlFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		io.Copy(io.Discard, r.Body)
		conn, _, _ := w.(http.Hijacker).Hijack()
		conn.Close()
	})
	body := []byte(`{"operation":"jobs.submit","args":{"key":"11111111-2222-4333-8444-555555555555"}}`)
	frame := controlFrame("/api/call", body)
	first, _ := s.request(frame, body)
	second, _ := s.request(frame, body)
	if first.OK || !first.WriteMayHaveReachedPeer || second.Code != "SESSION_STOPPED" || calls.Load() != 1 {
		t.Fatalf("control request replayed or lost uncertainty: %+v / %+v / %d", first, second, calls.Load())
	}
}

func controlFrame(path string, body []byte) frame {
	return frame{Op: "control", Control: &controlSpec{Origin: "https://campus.invalid", Path: path, Token: "fixture-private-token"}, BodyBytes: len(body)}
}
func controlFixture(t *testing.T, h http.HandlerFunc) *session {
	s, _, server, _ := fixture(t, h)
	s.controlEnabled = true
	s.controlDialFn = func(ctx context.Context, network, address string) (net.Conn, error) {
		if network != "tcp4" || address != "campus.invalid:443" {
			t.Errorf("unexpected destination")
		}
		return (&net.Dialer{}).DialContext(ctx, "tcp", server.Listener.Addr().String())
	}
	return s
}
func TestControlFullResponseAndNon2xx(t *testing.T) {
	var calls atomic.Int64
	s := controlFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/api/call" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer fixture-private-token" {
			t.Error("request identity")
		}
		b, _ := io.ReadAll(r.Body)
		if !bytes.Equal(b, []byte(`{"operation":"state","args":{}}`)) {
			t.Error("body changed")
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(403)
		io.WriteString(w, `{"error":"forbidden"}`)
	})
	b := []byte(`{"operation":"state","args":{}}`)
	o, raw := s.request(controlFrame("/api/call", b), b)
	if !o.OK || o.Status != 403 || string(raw) != `{"error":"forbidden"}` || o.BodyBytes != len(raw) || calls.Load() != 1 {
		t.Fatalf("%+v", o)
	}
}
func TestControlLargeStateAndReuse(t *testing.T) {
	payload := `{"state":"` + strings.Repeat("x", 3*chunkLimit) + `"}`
	s := controlFixture(t, func(w http.ResponseWriter, r *http.Request) { io.Copy(io.Discard, r.Body); io.WriteString(w, payload) })
	b := []byte(`{"operation":"state","args":{}}`)
	for seq := int64(1); seq <= 2; seq++ {
		o, raw := s.request(controlFrame("/api/call", b), b)
		if !o.OK || string(raw) != payload {
			t.Fatalf("%+v", o)
		}
	}
}

func gzipControlFixture(t *testing.T, payload []byte) []byte {
	t.Helper()
	var compressed bytes.Buffer
	w := gzip.NewWriter(&compressed)
	if _, err := w.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return compressed.Bytes()
}

func TestControlGzipStateNon2xxAndConnectionReuse(t *testing.T) {
	payload := []byte(`{"state":"` + strings.Repeat("x", 4*chunkLimit) + `"}`)
	compressed := gzipControlFixture(t, payload)
	var calls atomic.Int64
	var remote string
	s := controlFixture(t, func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		if r.Header.Get("Accept-Encoding") != "gzip" || r.Header.Get("Authorization") != "Bearer fixture-private-token" {
			t.Error("fixed compression negotiation or authorization changed")
		}
		if remote != "" && remote != r.RemoteAddr {
			t.Error("complete gzip reply did not retain its connection")
		}
		remote = r.RemoteAddr
		w.Header().Set("Content-Encoding", "gzip")
		if calls.Add(1) == 2 {
			w.WriteHeader(403)
			w.Write(gzipControlFixture(t, []byte(`{"error":"forbidden"}`)))
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(compressed)))
		w.Write(compressed)
	})
	b := []byte(`{"operation":"state","args":{}}`)
	o, raw := s.request(controlFrame("/api/call", b), b)
	if !o.OK || o.Status != 200 || !bytes.Equal(raw, payload) || o.BodyBytes != len(payload) {
		t.Fatalf("large decoded state failed: %+v", o)
	}
	o, raw = s.request(controlFrame("/api/call", b), b)
	if !o.OK || o.Status != 403 || string(raw) != `{"error":"forbidden"}` || calls.Load() != 2 {
		t.Fatalf("decoded non-2xx changed: %+v", o)
	}
}

func TestControlGzipCorruptionStopsWithoutPartialReplyOrReplay(t *testing.T) {
	valid := gzipControlFixture(t, []byte(`{"result":"fixture-private-token"}`))
	corrupt := append([]byte(nil), valid...)
	corrupt[len(corrupt)-8] ^= 0xff
	for name, payload := range map[string][]byte{"truncated": valid[:len(valid)-5], "checksum": corrupt, "header": []byte("invalid gzip")} {
		t.Run(name, func(t *testing.T) {
			var calls atomic.Int64
			s := controlFixture(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				io.Copy(io.Discard, r.Body)
				w.Header().Set("Content-Encoding", "gzip")
				w.Write(payload)
			})
			b := []byte(`{"operation":"state","args":{}}`)
			o, raw := s.request(controlFrame("/api/call", b), b)
			if o.OK || o.Code != "RESPONSE_INTERRUPTED" || !o.WriteMayHaveReachedPeer || len(raw) != 0 || o.BodyBytes != 0 {
				t.Fatalf("invalid compressed body was exposed: %+v", o)
			}
			o, _ = s.request(controlFrame("/api/call", b), b)
			if o.Code != "SESSION_STOPPED" || calls.Load() != 1 {
				t.Fatal("failed compressed control request was replayed")
			}
		})
	}
}

func TestControlGzipDecodedLimitAndUnsupportedEncodings(t *testing.T) {
	large := gzipControlFixture(t, bytes.Repeat([]byte("x"), controlResponseLimit+1))
	for _, encodings := range [][]string{{"gzip"}, {"br"}, {"gzip, br"}, {"gzip", "gzip"}} {
		t.Run(strings.Join(encodings, "/"), func(t *testing.T) {
			s := controlFixture(t, func(w http.ResponseWriter, r *http.Request) {
				io.Copy(io.Discard, r.Body)
				for _, value := range encodings {
					w.Header().Add("Content-Encoding", value)
				}
				w.Write(large)
			})
			b := []byte(`{}`)
			o, raw := s.request(controlFrame("/api/logout", b), b)
			if o.OK || o.Code != "RESPONSE_INVALID" || len(raw) != 0 {
				t.Fatalf("response limit/encoding was relaxed: %+v", o)
			}
		})
	}
}
func TestControlLostAckNoReplayAndNoCredentialReply(t *testing.T) {
	var calls atomic.Int64
	s := controlFixture(t, func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		calls.Add(1)
		c, _, _ := w.(http.Hijacker).Hijack()
		c.Close()
	})
	b := []byte(`{"username":"member","password":"fixture-secret-password"}`)
	f := controlFrame("/api/login", b)
	o, raw := s.request(f, b)
	encoded, _ := json.Marshal(o)
	if o.OK || !o.WriteMayHaveReachedPeer || len(raw) != 0 || bytes.Contains(encoded, []byte("fixture-secret")) || bytes.Contains(encoded, []byte("private-token")) {
		t.Fatalf("unexpected reply %+v", o)
	}
	o, _ = s.request(f, b)
	if o.Code != "SESSION_STOPPED" || calls.Load() != 1 {
		t.Fatal("replayed original write")
	}
}
func TestControlTLSBeforeCredentials(t *testing.T) {
	var calls atomic.Int64
	s := controlFixture(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
	s.roots = nil
	b := []byte(`{"password":"fixture-secret"}`)
	o, _ := s.request(controlFrame("/api/login", b), b)
	if o.Code != "TLS_CHAIN_OR_NAME" || o.WriteMayHaveReachedPeer || calls.Load() != 0 {
		t.Fatalf("%+v", o)
	}
}
func TestControlRedirectNotFollowed(t *testing.T) {
	var calls atomic.Int64
	s := controlFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Location", "https://other.invalid/api/login")
		w.WriteHeader(307)
		io.WriteString(w, `{"error":"redirect"}`)
	})
	b := []byte(`{}`)
	o, raw := s.request(controlFrame("/api/logout", b), b)
	if !o.OK || o.Status != 307 || len(raw) == 0 || calls.Load() != 1 {
		t.Fatal("redirect changed")
	}
}
func TestControlOriginChangeAndLimits(t *testing.T) {
	var calls atomic.Int64
	s := controlFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		io.Copy(io.Discard, r.Body)
		io.WriteString(w, `{}`)
	})
	b := []byte(`{}`)
	f := controlFrame("/api/logout", b)
	o, _ := s.request(f, b)
	if !o.OK {
		t.Fatal(o.Code)
	}
	f.Control = &controlSpec{Origin: "https://other.invalid", Path: "/api/logout"}
	o, _ = s.request(f, b)
	if o.Code != "CONTROL_ORIGIN_CHANGED" || calls.Load() != 1 {
		t.Fatal("origin changed")
	}
	for _, patch := range []func(*frame){func(f *frame) { f.BodyBytes = controlRequestLimit + 1 }, func(f *frame) { f.Control.Origin = "http://campus.invalid" }, func(f *frame) { f.Control.Origin = "https://campus.invalid:444" }, func(f *frame) { f.Control.Path = "/api/call?url=x" }, func(f *frame) { f.Control.Token = "t\r\nX:bad" }} {
		f = controlFrame("/api/login", b)
		patch(&f)
		if validate(f) == nil {
			t.Fatal("accepted invalid frame")
		}
	}
}
func TestControlResponseOverflow(t *testing.T) {
	var calls atomic.Int64
	s := controlFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Length", "67108865")
		w.WriteHeader(200)
	})
	b := []byte(`{}`)
	o, _ := s.request(controlFrame("/api/logout", b), b)
	if o.Code != "RESPONSE_INVALID" || !o.WriteMayHaveReachedPeer || calls.Load() != 1 {
		t.Fatalf("%+v", o)
	}

}
func TestControlPlatformDisabledAndDataMix(t *testing.T) {
	s := controlFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected request") })
	s.controlEnabled = false
	b := []byte(`{}`)
	o, _ := s.request(controlFrame("/api/logout", b), b)
	if o.Code != "PLATFORM_UNSUPPORTED" {
		t.Fatal(o.Code)
	}
	s = controlFixture(t, func(w http.ResponseWriter, r *http.Request) { io.Copy(io.Discard, r.Body); io.WriteString(w, `{}`) })
	o, _ = s.request(controlFrame("/api/logout", b), b)
	if !o.OK {
		t.Fatal(o.Code)
	}
	o, _ = s.request(frame{Op: "probe"}, nil)
	if o.Code != "SESSION_IDENTITY_CHANGED" {
		t.Fatal(o.Code)
	}
}

func TestOperationIgnoresUnrelatedFrameFields(t *testing.T) {
	control := controlFrame("/api/login", []byte(`{}`))
	control.Endpoint = "unused"
	control.DialEndpoint = "unused"
	control.Pin = "unused"
	control.ProbeTimeoutMs = -1
	control.Offset = -1
	control.Final = new(bool)
	if err := validate(control); err != nil {
		t.Fatal("unrelated data fields blocked control request", err)
	}
	_, g, _, _ := fixture(t, func(http.ResponseWriter, *http.Request) {})
	download := frame{Op: "get", Grant: g, Final: new(bool)}
	if err := validate(download); err != nil {
		t.Fatal("unused upload flag blocked download", err)
	}
	data := put(g, 0, nil, true)
	data.ProbeTimeoutMs = -1
	data.Control = &controlSpec{Origin: "unused", Path: "unused"}
	if err := validate(data); err != nil {
		t.Fatal("unrelated control fields blocked upload", err)
	}
}
