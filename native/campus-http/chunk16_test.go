package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

func TestNegotiatedPersonal16MiBActualTLS(t *testing.T) {
	data := bytes.Repeat([]byte{0, 255, 42, 13}, personalChunkLimit/4)
	requests := 0
	s, g, _, connections := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "POST" {
			body, e := io.ReadAll(r.Body)
			if e != nil || !bytes.Equal(body, data) {
				t.Error("large fixed payload changed")
			}
			io.WriteString(w, `{"ok":true,"result":{"complete":true}}`)
			return
		}
		meta, _ := json.Marshal(map[string]any{"protocol": 2, "path": "source.bin", "size": len(data), "offset": 0, "eof": true})
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("X-GPUQ-File-Metadata", base64.RawURLEncoding.EncodeToString(meta))
		w.Write(data)
	})
	g.Chunk = personalChunkLimit
	g.MaxChunk = personalChunkLimit
	g.File.Size = int64(len(data))
	out, raw := s.request(put(g, 1, 0, data, true), data)
	if !out.OK || len(raw) != 0 {
		t.Fatalf("PUT %+v", out)
	}
	out, raw = s.request(put(g, 2, 0, data, true), data)
	if !out.OK || len(raw) != 0 {
		t.Fatalf("second PUT %+v", out)
	}
	read := &session{roots: s.roots, routeFn: s.routeFn, dialFn: s.dialFn}
	t.Cleanup(read.close)
	out, raw = read.request(frame{Schema: 1, Seq: 1, Op: "get", Grant: g}, nil)
	if !out.OK || !bytes.Equal(raw, data) {
		t.Fatalf("GET %+v bytes=%d", out, len(raw))
	}
	if requests != 3 || connections.Load() != 2 {
		t.Fatalf("requests=%d connections=%d", requests, connections.Load())
	}
}
func TestPersonalNegotiationBoundsBeforeAnyDial(t *testing.T) {
	s, g, _, connections := fixture(t, func(w http.ResponseWriter, r *http.Request) { t.Fatal("invalid frame reached listener") })
	_ = s
	for _, bound := range []int{0, chunkLimit + 1, 32 * chunkLimit} {
		g.Chunk = bound
		g.MaxChunk = personalChunkLimit
		if validate(put(g, 1, 0, nil, false)) == nil {
			t.Fatalf("accepted chunk %d", bound)
		}
	}
	g.Chunk = chunkLimit
	g.MaxChunk = 0
	if validate(put(g, 1, 0, make([]byte, chunkLimit+1), false)) == nil {
		t.Fatal("old grant accepted oversize")
	}
	g.Chunk = personalChunkLimit
	g.MaxChunk = personalChunkLimit
	f := put(g, 1, 0, nil, false)
	f.BodyBytes = personalChunkLimit + 1
	if validate(f) == nil {
		t.Fatal("oversize accepted")
	}
	g.MaxChunk = 0
	if validate(put(g, 1, 0, nil, false)) == nil {
		t.Fatal("16MiB without negotiated maximum accepted")
	}
	if connections.Load() != 0 {
		t.Fatal("bad frame dialed")
	}
}
