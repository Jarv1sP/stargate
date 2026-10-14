package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const controlRequestLimit = chunkLimit
const controlResponseLimit = 64 * chunkLimit

type controlSpec struct {
	Origin string `json:"origin"`
	Path   string `json:"path"`
	Token  string `json:"token,omitempty"`
}
type controlSession struct {
	origin  *url.URL
	routeFn func() (route, error)
	dialFn  func(context.Context, string, string) (net.Conn, error)
	roots   *x509.CertPool
	initial route
	conn    *tls.Conn
	reader  *bufio.Reader
}

func validateControl(f frame) error {
	c := f.Control
	if c == nil || f.BodyBytes > controlRequestLimit || f.Endpoint != "" || f.DialEndpoint != "" || f.ProbeTimeoutMs != 0 || f.Pin != "" || f.Offset != 0 || f.Final != nil {
		return errors.New("INVALID_CONTROL_FRAME")
	}
	u, e := origin(c.Origin)
	if e != nil || (u.Port() != "" && u.Port() != "443") {
		return errors.New("INVALID_CONTROL_ORIGIN")
	}
	if c.Path != "/api/call" && c.Path != "/api/login" && c.Path != "/api/logout" && c.Path != "/api/register" {
		return errors.New("INVALID_CONTROL_PATH")
	}
	if len(c.Token) > 8192 || (c.Token != "" && !ticketRE.MatchString(c.Token)) {
		return errors.New("INVALID_CONTROL_TOKEN")
	}
	return nil
}

func (c *controlSession) close() {
	if c.conn != nil {
		c.conn.Close()
		c.conn = nil
		c.reader = nil
	}
}
func (c *controlSession) connect(ctx context.Context) error {
	raw, e := c.dialFn(ctx, "tcp4", net.JoinHostPort(c.origin.Hostname(), "443"))
	if e != nil {
		return e
	}
	conn := tls.Client(raw, &tls.Config{MinVersion: tls.VersionTLS12, ServerName: c.origin.Hostname(), RootCAs: c.roots, NextProtos: []string{"http/1.1"}})
	if e = conn.HandshakeContext(ctx); e != nil {
		conn.Close()
		return handshakeFailure(e)
	}
	c.conn = conn
	c.reader = bufio.NewReaderSize(conn, 4096)
	return nil
}
func (s *session) controlRequest(f frame, body []byte) (out reply, raw []byte) {
	out = reply{Schema: 1, Seq: f.Seq, UID: processUID()}
	started := false
	fail := func(e error) (reply, []byte) {
		s.stopped = true
		s.close()
		out.Code = e.Error()
		out.WriteMayHaveReachedPeer = started
		return out, nil
	}
	if s.stopped {
		return fail(errors.New("SESSION_STOPPED"))
	}
	if !s.controlEnabled || s.controlDialFn == nil {
		return fail(errors.New("PLATFORM_UNSUPPORTED"))
	}
	if len(body) != f.BodyBytes {
		return fail(errors.New("INVALID_CONTROL_FRAME"))
	}
	if s.fixed != "" {
		return fail(errors.New("SESSION_IDENTITY_CHANGED"))
	}
	if s.control == nil {
		u, _ := origin(f.Control.Origin)
		s.control = &controlSession{origin: u, routeFn: s.routeFn, dialFn: s.controlDialFn, roots: s.roots}
	} else if s.control.origin.String() != f.Control.Origin {
		return fail(errors.New("CONTROL_ORIGIN_CHANGED"))
	}
	c := s.control
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if c.conn == nil {
		if e := c.connect(ctx); e != nil {
			return fail(e)
		}
	}
	deadline, _ := ctx.Deadline()
	c.conn.SetDeadline(deadline)
	target := *c.origin
	target.Path = f.Control.Path
	req, e := http.NewRequestWithContext(ctx, "POST", target.String(), bytes.NewReader(body))
	if e != nil {
		return fail(errors.New("INVALID_CONTROL_FRAME"))
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	// This raw HTTP/1.1 path has no Transport to negotiate/decode for us.
	// Keep the encoding fixed here rather than accepting caller headers.
	req.Header.Set("Accept-Encoding", "gzip")
	req.ContentLength = int64(len(body))
	// Credentials and body are written only after verified TLS. Exactly one
	// Request.Write attempt; net/http Transport implicit retries are absent.
	if f.Control.Token != "" {
		req.Header.Set("Authorization", "Bearer "+f.Control.Token)
	}
	started = true
	if e = req.Write(c.conn); e != nil {
		return fail(errors.New("ACK_UNCONFIRMED"))
	}
	res, e := readResponse(c.reader, req)
	if e != nil {
		return fail(e)
	}
	defer res.Body.Close()
	if res.ContentLength > controlResponseLimit {
		return fail(errors.New("RESPONSE_INVALID"))
	}
	encodings := res.Header.Values("Content-Encoding")
	if len(encodings) > 1 {
		return fail(errors.New("RESPONSE_INVALID"))
	}
	encoding := strings.TrimSpace(res.Header.Get("Content-Encoding"))
	wire := &io.LimitedReader{R: res.Body, N: controlResponseLimit + 1}
	var decoded io.Reader = wire
	if strings.EqualFold(encoding, "gzip") {
		reader, err := gzip.NewReader(wire)
		if err != nil {
			return fail(errors.New("RESPONSE_INTERRUPTED"))
		}
		defer reader.Close()
		decoded = reader
	} else if encoding != "" && !strings.EqualFold(encoding, "identity") {
		return fail(errors.New("RESPONSE_INVALID"))
	}
	payload, e := io.ReadAll(io.LimitReader(decoded, controlResponseLimit+1))
	if e != nil {
		return fail(errors.New("RESPONSE_INTERRUPTED"))
	}
	if len(payload) > controlResponseLimit || wire.N <= 0 {
		return fail(errors.New("RESPONSE_INVALID"))
	}
	// Non-2xx is a complete HTTP reply for apiPost to interpret. A redirect is
	// returned unchanged and never followed by the helper.
	out.Status = res.StatusCode
	out.OK = true
	out.BodyBytes = len(payload)
	if res.Close {
		c.close()
	}
	return out, payload
}
