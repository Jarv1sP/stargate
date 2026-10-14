package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func TestHTTPRejectionDetailsAndNoReplay(t *testing.T) {
	for _, status := range []int{403, 409, 429} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var requests atomic.Int64
			s, g, _, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				io.Copy(io.Discard, r.Body)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				json.NewEncoder(w).Encode(map[string]any{"code": "upload-rejected", "error": "Upload state changed; check portal status and resume", "ticket": strings.Repeat("t", 32), "grant": map[string]any{"private": "never-return-this"}})
			})
			body := []byte("raw")
			f := put(g, 1, 0, body, true)
			out, raw := s.request(f, body)
			if out.OK || out.Code != "HTTP_REJECTED" || out.Status != status || len(raw) != 0 {
				t.Fatalf("unexpected safe rejection: %+v", out)
			}
			if status != 429 && (out.ReasonCode != "upload-rejected" || !out.WriteMayHaveReachedPeer || out.NodeError != "Upload state changed; check portal status and resume") {
				t.Fatalf("write rejection lost status: %+v", out)
			}
			if status == 429 && (out.RetryAfterMs <= 0 || out.WriteMayHaveReachedPeer) {
				t.Fatalf("busy response did not preserve bounded wait: %+v", out)
			}
			encoded, _ := json.Marshal(out)
			for _, secret := range []string{g.Ticket, g.ID, "never-return-this", `"grant"`, `"ticket"`} {
				if strings.Contains(string(encoded), secret) {
					t.Fatal("private response field escaped")
				}
			}
			if requests.Load() != 1 {
				t.Fatal("rejected request was automatically replayed")
			}
			if status != 429 {
				if out, _ := s.request(f, body); out.Code != "SESSION_STOPPED" || requests.Load() != 1 {
					t.Fatal("rejected write replayed")
				}
			}
		})
	}
}

func TestHTTPRejectionWhitelist(t *testing.T) {
	f := frame{Grant: grant{Ticket: "opaque-header-secret.opaque-nonce-secret", ID: "01234567-1234-4234-8234-012345678901"}}
	for _, tc := range []struct{ name, payload, code, message string }{
		{"preferred-code", `{"reasonCode":"CAMPUS_FILE_REQUIRED","code":"ignored","error":"校园文件授权已失效，请核对原操作。","ticket":"hidden","grant":{"hidden":true}}`, "CAMPUS_FILE_REQUIRED", "校园文件授权已失效，请核对原操作。"},
		{"legacy-code", `{"code":"upload-rejected","error":"State changed"}`, "upload-rejected", "State changed"},
		{"malformed", `<html>secret</html>`, "", ""},
		{"nested", `{"reasonCode":{"secret":true},"error":{"ticket":"hidden"}}`, "", ""},
		{"invalid-code", `{"reasonCode":"not a code","error":"Safe message"}`, "", "Safe message"},
		{"control", `{"code":"SAFE","error":"line\nsecret"}`, "SAFE", ""},
		{"bidi", `{"code":"SAFE","error":"text\u202esecret"}`, "SAFE", ""},
		{"ticket", `{"code":"SAFE","error":"opaque-header-secret.opaque-nonce-secret"}`, "SAFE", ""},
		{"ticket-part", `{"code":"SAFE","error":"OPAQUE-NONCE-SECRET"}`, "SAFE", ""},
		{"grant-id", `{"code":"SAFE","error":"grant 01234567-1234-4234-8234-012345678901"}`, "SAFE", ""},
		{"upload-id", `{"code":"SAFE","error":"upload 12345678-1234-4234-8234-123456789012"}`, "SAFE", "upload 12345678-1234-4234-8234-123456789012"},
		{"bearer", `{"code":"SAFE","error":"Bearer arbitrary-secret"}`, "SAFE", ""},
		{"serialized-grant", `{"code":"SAFE","error":"grant {hidden}"}`, "SAFE", ""},
		{"long-message", `{"code":"SAFE","error":"` + strings.Repeat("a", 513) + `"}`, "SAFE", ""},
		{"oversized-document", `{"code":"SAFE","unknown":"` + strings.Repeat("a", 4096) + `"}`, "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, message := rejectionDetails([]byte(tc.payload), f)
			if code != tc.code || message != tc.message {
				t.Fatalf("unexpected fields: %q %q", code, message)
			}
		})
	}
}
