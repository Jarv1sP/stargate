package main

import (
	"bytes"
	"io"
	"net/http"
	"sync/atomic"
	"testing"
)

func TestControlWorkspacePullKeepsAuthenticatedReadScope(t *testing.T) {
	body := []byte(`{"operation":"files.get","args":{"machine":"fixture-node","project":"fixture-project","area":"code","path":"smoke.bin","offset":0}}`)
	want := []byte(`{"result":{"protocol":2,"offset":0,"size":3,"data":"YWJj","eof":true}}`)
	var calls atomic.Int64
	s := controlFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		actual, err := io.ReadAll(r.Body)
		if err != nil || !bytes.Equal(actual, body) || r.Header.Get("Authorization") != "Bearer fixture-private-token" || r.URL.Path != "/api/call" {
			t.Error("workspace pull lost its exact authenticated scope")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(want)
	})
	out, raw := s.request(controlFrame(1, "/api/call", body), body)
	if !out.OK || out.Status != 200 || calls.Load() != 1 || !bytes.Equal(raw, want) {
		t.Fatalf("workspace pull: code=%s status=%d calls=%d raw=%q", out.Code, out.Status, calls.Load(), raw)
	}
}
