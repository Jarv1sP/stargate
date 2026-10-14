package main

import (
	"strings"
	"testing"
	"time"
)

func ticketInt(n int64) *int64 { return &n }

func TestTicketClockSkew(t *testing.T) {
	const server int64 = 1700000000
	for _, skew := range []int64{-5, 5, -119} {
		for _, metadata := range []bool{false, true} {
			g := grant{Expires: server + 300}
			if metadata {
				g.IssuedAt, g.TTL = ticketInt(server), ticketInt(300)
			}
			if !validGrantTime(g, server+skew) {
				t.Fatalf("skew=%d metadata=%v rejected", skew, metadata)
			}
		}
	}
	for _, tc := range []struct {
		expires int64
		want    bool
	}{{server - 119, true}, {server - 120, false}, {server + 420, true}, {server + 421, false}, {0, false}, {maxInteger + 1, false}} {
		if got := validGrantTime(grant{Expires: tc.expires}, server); got != tc.want {
			t.Fatalf("expires=%d got=%v want=%v", tc.expires, got, tc.want)
		}
	}
}

func TestTicketIssuanceMetadata(t *testing.T) {
	const server int64 = 1700000000
	g := grant{Expires: server + 30, IssuedAt: ticketInt(server), TTL: ticketInt(30)}
	if !validGrantTime(g, server-119) {
		t.Fatal("server TTL with bounded slow clock rejected")
	}
	for _, change := range []func(*grant){
		func(g *grant) { g.TTL = nil }, func(g *grant) { g.IssuedAt = nil },
		func(g *grant) { g.TTL = ticketInt(301) }, func(g *grant) { g.TTL = ticketInt(0) },
		func(g *grant) { g.Expires++ }, func(g *grant) { g.IssuedAt = ticketInt(-1) },
		func(g *grant) { g.IssuedAt = ticketInt(server + 121); g.Expires = server + 151 },
	} {
		bad := g
		change(&bad)
		if validGrantTime(bad, server) {
			t.Fatalf("invalid metadata accepted: %+v", bad)
		}
	}
}

func TestTicketSkewPreservesFrameGuards(t *testing.T) {
	g := grant{Endpoint: "https://campus.invalid", Pin: strings.Repeat("a", 64), ID: "12345678-1234-4234-8234-123456789012", Ticket: strings.Repeat("t", 32), Expires: time.Now().Unix() + 419, Chunk: chunkLimit}
	f := put(g, 1, 0, nil, true)
	if err := validate(f); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*frame){func(f *frame) { f.Grant.Pin = "invalid" }, func(f *frame) { f.Grant.Chunk = 2 * chunkLimit }, func(f *frame) { f.BodyBytes = personalChunkLimit + 1 }, func(f *frame) { f.Grant.ID = "invalid" }} {
		bad := f
		change(&bad)
		if validate(bad) == nil {
			t.Fatal("TLS authentication or byte bound was relaxed")
		}
	}
}
