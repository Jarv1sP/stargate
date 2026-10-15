// A stdin/stdout-only, bounded HTTPS transport. No shell, proxy, route writes,
// privilege changes, bearer logging, redirects, or request replay.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const chunkLimit = 1048576
const personalChunkLimit = 16 * chunkLimit
const headerLimit = 16384
const maxInteger = 9007199254740991

var hashRE = regexp.MustCompile(`^[a-f0-9]{64}$`)
var uuidRE = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var ticketRE = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

type fileIdentity struct {
	Size int64 `json:"size"`
}
type grant struct {
	Endpoint string       `json:"endpoint"`
	Pin      string       `json:"certificateSha256"`
	ID       string       `json:"grantId"`
	Ticket   string       `json:"ticket"`
	Chunk    int          `json:"chunkBytes"`
	MaxChunk int          `json:"maxChunkBytes,omitempty"`
	File     fileIdentity `json:"file"`
}
type frame struct {
	Op             string       `json:"op"`
	Grant          grant        `json:"grant"`
	Endpoint       string       `json:"endpoint,omitempty"`
	DialEndpoint   string       `json:"dialEndpoint,omitempty"`
	ProbeTimeoutMs int          `json:"probeTimeoutMs,omitempty"`
	Pin            string       `json:"certificateSha256,omitempty"`
	Offset         int64        `json:"offset"`
	Final          *bool        `json:"final,omitempty"`
	BodyBytes      int          `json:"bodyBytes"`
	Control        *controlSpec `json:"control,omitempty"`
}

func writing(op string) bool { return op == "put" }

type reply struct {
	OK                      bool            `json:"ok"`
	Code                    string          `json:"code,omitempty"`
	Status                  int             `json:"status,omitempty"`
	ReasonCode              string          `json:"reasonCode,omitempty"`
	NodeError               string          `json:"error,omitempty"`
	AdmissionRejected       bool            `json:"admissionRejected,omitempty"`
	RetryAfterMs            int             `json:"retryAfterMs,omitempty"`
	Result                  json.RawMessage `json:"result,omitempty"`
	Metadata                json.RawMessage `json:"metadata,omitempty"`
	BodyBytes               int             `json:"bodyBytes"`
	Interface               string          `json:"interface,omitempty"`
	WriteMayHaveReachedPeer bool            `json:"writeMayHaveReachedPeer,omitempty"`
}
type session struct {
	controlEnabled bool
	controlDialFn  func(context.Context, string, string) (net.Conn, error)
	control        *controlSession
	routeFn        func() (route, error)
	dialFn         func(context.Context, route, string, string) (net.Conn, error)
	roots          *x509.CertPool
	initial        route
	fixed          string
	origin         *url.URL
	dialOrigin     *url.URL
	pin            string
	conn           *tls.Conn
	reader         *bufio.Reader
	stopped        bool
}

func origin(value string) (*url.URL, error) {
	u, e := url.Parse(value)
	if e != nil || u.Scheme != "https" || u.User != nil || u.Hostname() == "" || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || u.Opaque != "" || u.String() != value {
		return nil, errors.New("INVALID_ORIGIN")
	}
	p := u.Port()
	if p != "" {
		n, e := strconv.Atoi(p)
		if e != nil || n < 1 || n > 65535 {
			return nil, errors.New("INVALID_ORIGIN")
		}
	}
	return u, nil
}
func validate(f frame) error {
	if f.BodyBytes < 0 || f.BodyBytes > personalChunkLimit {
		return errors.New("INVALID_FRAME")
	}
	if f.Op == "control" {
		return validateControl(f)
	}
	if f.DialEndpoint != "" {
		u, e := origin(f.DialEndpoint)
		if e != nil || net.ParseIP(u.Hostname()) == nil || net.ParseIP(u.Hostname()).To4() == nil || !net.ParseIP(u.Hostname()).IsPrivate() {
			return errors.New("INVALID_DIAL_ENDPOINT")
		}
	}
	if f.Op == "probe" && f.ProbeTimeoutMs != 0 && (f.ProbeTimeoutMs < 1 || f.ProbeTimeoutMs > 2500) {
		return errors.New("INVALID_PROBE_TIMEOUT")
	}
	if f.Op != "probe" && (f.Offset < 0 || f.Offset > maxInteger) {
		return errors.New("INVALID_FRAME")
	}
	if f.Op == "probe" {
		if f.BodyBytes != 0 || !hashRE.MatchString(f.Pin) {
			return errors.New("INVALID_FRAME")
		}
		_, e := origin(f.Endpoint)
		return e
	}
	g := f.Grant
	if !hashRE.MatchString(g.Pin) || !ticketRE.MatchString(g.Ticket) || len(g.Ticket) < 20 || len(g.Ticket) > 4096 {
		return errors.New("INVALID_GRANT")
	}
	if (f.Op != "get" && f.Op != "put") || !uuidRE.MatchString(g.ID) || (g.Chunk != chunkLimit && g.Chunk != personalChunkLimit) || (g.MaxChunk != 0 && g.MaxChunk != chunkLimit && g.MaxChunk != personalChunkLimit) || (g.Chunk == personalChunkLimit && g.MaxChunk != personalChunkLimit) || f.BodyBytes > g.Chunk {
		return errors.New("INVALID_GRANT")
	}
	if f.Op == "put" && f.Final == nil || f.Op == "get" && (f.BodyBytes != 0 || g.File.Size < 0 || g.File.Size > maxInteger) {
		return errors.New("INVALID_FRAME")
	}
	_, e := origin(g.Endpoint)
	return e
}
func (s *session) close() {
	if s.control != nil {
		s.control.close()
	}
	if s.conn != nil {
		s.conn.Close()
		s.conn = nil
		s.reader = nil
	}
}
func (s *session) network() error {
	if s.conn != nil {
		return nil
	}
	r, err := s.routeFn()
	if err == nil {
		s.initial = r
	}
	return err
}
func (s *session) connect(ctx context.Context) error {
	dialOrigin := s.origin
	if s.dialOrigin != nil {
		dialOrigin = s.dialOrigin
	}
	port := dialOrigin.Port()
	if port == "" {
		port = "443"
	}
	raw, e := s.dialFn(ctx, s.initial, dialOrigin.Hostname(), port)
	if e != nil {
		return e
	}
	conn := tls.Client(raw, &tls.Config{MinVersion: tls.VersionTLS12, ServerName: s.origin.Hostname(), RootCAs: s.roots, NextProtos: []string{"http/1.1"}})
	if e = conn.HandshakeContext(ctx); e != nil {
		conn.Close()
		return handshakeFailure(e)
	}
	certs := conn.ConnectionState().PeerCertificates
	want, _ := hex.DecodeString(s.pin)
	if len(certs) == 0 {
		conn.Close()
		return errors.New("TLS_PIN_CHANGED")
	}
	actual := sha256.Sum256(certs[0].Raw)
	if subtle.ConstantTimeCompare(actual[:], want) != 1 {
		conn.Close()
		return errors.New("TLS_PIN_CHANGED")
	}
	s.conn = conn
	s.reader = bufio.NewReaderSize(conn, 4096)
	return nil
}

// Never expose certificate names, network addresses or raw TLS errors on the
// framed wire. A transport EOF/timeout is not proof of a trust or pin failure.
func handshakeFailure(err error) error {
	var verification *tls.CertificateVerificationError
	var authority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	if errors.As(err, &verification) || errors.As(err, &authority) || errors.As(err, &hostname) || errors.As(err, &invalid) {
		return errors.New("TLS_CHAIN_OR_NAME")
	}
	var network net.Error
	if errors.Is(err, context.DeadlineExceeded) || errors.As(err, &network) && network.Timeout() {
		return errors.New("HANDSHAKE_TIMEOUT")
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return errors.New("HANDSHAKE_EOF")
	}
	return errors.New("HANDSHAKE_FAILED")
}
func readResponse(reader *bufio.Reader, req *http.Request) (*http.Response, error) {
	// Bound status/header bytes before net/http's parser allocates MIME fields.
	header := []byte{}
	for {
		line, e := reader.ReadSlice('\n')
		if e != nil {
			return nil, errors.New("RESPONSE_INTERRUPTED")
		}
		header = append(header, line...)
		if len(header) > headerLimit {
			return nil, errors.New("RESPONSE_INVALID")
		}
		if bytes.Equal(line, []byte("\r\n")) {
			break
		}
	}
	res, e := http.ReadResponse(bufio.NewReader(io.MultiReader(bytes.NewReader(header), reader)), req)
	if e != nil {
		return nil, errors.New("RESPONSE_INVALID")
	}
	return res, nil
}
func (s *session) request(f frame, body []byte) (out reply, raw []byte) {
	if f.Op == "control" {
		return s.controlRequest(f, body)
	}
	if s.control != nil {
		s.stopped = true
		s.close()
		return reply{Code: "SESSION_IDENTITY_CHANGED"}, nil
	}
	out = reply{}
	started := false
	fail := func(e error) (reply, []byte) {
		s.stopped = true
		s.close()
		out.Code = e.Error()
		out.WriteMayHaveReachedPeer = started && writing(f.Op)
		return out, nil
	}
	if s.stopped {
		return fail(errors.New("SESSION_STOPPED"))
	}
	if len(body) != f.BodyBytes {
		return fail(errors.New("INVALID_FRAME"))
	}
	if e := s.network(); e != nil {
		return fail(e)
	}
	endpoint, pin := f.Endpoint, f.Pin
	if f.Op != "probe" {
		g := f.Grant
		endpoint, pin = g.Endpoint, g.Pin
	}
	identity := endpoint + "\x00" + f.DialEndpoint + "\x00" + pin
	if s.fixed == "" {
		s.fixed = identity
		s.origin, _ = origin(endpoint)
		if f.DialEndpoint != "" {
			s.dialOrigin, _ = origin(f.DialEndpoint)
		}
		s.pin = pin
	} else if identity != s.fixed {
		return fail(errors.New("GRANT_IDENTITY_CHANGED"))
	}
	duration := 30 * time.Second
	if f.Op == "probe" && f.ProbeTimeoutMs > 0 {
		duration = time.Duration(f.ProbeTimeoutMs) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(context.Background(), duration)
	defer cancel()
	if s.conn == nil {
		if e := s.connect(ctx); e != nil {
			return fail(e)
		}
	}
	deadline, _ := ctx.Deadline()
	s.conn.SetDeadline(deadline)
	target := *s.origin
	target.Path = "/capabilities"
	method := "GET"
	if f.Op != "probe" {
		target.Path = "/v1/files/" + f.Grant.ID + "/" + f.Op
		q := url.Values{}
		q.Set("offset", strconv.FormatInt(f.Offset, 10))
		if writing(f.Op) {
			method = "POST"
		}
		if f.Op == "put" {
			q.Set("final", strconv.FormatBool(*f.Final))
		}
		target.RawQuery = q.Encode()
	}
	req, e := http.NewRequestWithContext(ctx, method, target.String(), bytes.NewReader(body))
	if e != nil {
		return fail(errors.New("INVALID_FRAME"))
	}
	req.Header.Set("Accept", "application/json")
	if f.Op == "get" {
		req.Header.Set("Accept", "application/octet-stream")
	}
	// Only a verified TLS socket reaches this point, before bearer or raw bytes.
	if f.Op != "probe" {
		req.Header.Set("Authorization", "Bearer "+f.Grant.Ticket)
	}
	if writing(f.Op) {
		req.Header.Set("Content-Type", "application/octet-stream")
		req.ContentLength = int64(len(body))
	}
	started = true
	// Request.Write/ReadResponse make exactly ONE attempt, including empty final
	// writes on a reused socket. net/http.Transport's implicit retries are absent.
	// Admission can answer immediately after TLS, before reading a large body.
	// Read concurrently so Windows does not lose that reply to a write/reset.
	// There is still exactly one request; no network error permits replay.
	conn := s.conn
	writeDone := make(chan error, 1)
	go func() { writeDone <- req.Write(conn) }()
	writeFinished := false
	defer func() {
		if !writeFinished {
			conn.Close()
			<-writeDone
		}
	}()
	res, e := readResponse(s.reader, req)
	if e != nil {
		s.close()
		writeError := <-writeDone
		writeFinished = true
		if writeError != nil {
			return fail(errors.New("ACK_UNCONFIRMED"))
		}
		return fail(e)
	}
	defer res.Body.Close()
	out.Status = res.StatusCode
	limit := int64(f.Grant.Chunk)
	if f.Op != "get" {
		limit = 65536
	}
	if f.Op == "probe" {
		limit = 4096
	}
	if res.ContentLength > limit {
		return fail(errors.New("RESPONSE_INVALID"))
	}
	payload, e := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if e != nil {
		return fail(errors.New("RESPONSE_INTERRUPTED"))
	}
	if int64(len(payload)) > limit {
		return fail(errors.New("RESPONSE_INVALID"))
	}
	if delay := admissionBusyDelay(res); delay > 0 {
		s.close()
		<-writeDone
		writeFinished = true
		out.Code = "HTTP_REJECTED"
		out.ReasonCode = "LISTENER_BUSY"
		out.AdmissionRejected = true
		out.RetryAfterMs = delay
		return out, nil
	}
	writeError := <-writeDone
	writeFinished = true
	if writeError != nil {
		return fail(errors.New("ACK_UNCONFIRMED"))
	}
	if res.StatusCode != 200 {
		out.ReasonCode, out.NodeError = rejectionDetails(payload, f)
		return fail(errors.New("HTTP_REJECTED"))
	}
	if f.Op == "get" {
		encoded := res.Header.Get("X-GPUQ-File-Metadata")
		if len(encoded) > 4096 {
			return fail(errors.New("RESPONSE_INVALID"))
		}
		metadata, e := base64.RawURLEncoding.DecodeString(encoded)
		if e != nil {
			return fail(errors.New("RESPONSE_INVALID"))
		}
		var m struct {
			Size   int64 `json:"size"`
			Offset int64 `json:"offset"`
		}
		decoder := json.NewDecoder(bytes.NewReader(metadata))
		if decoder.Decode(&m) != nil || m.Size != f.Grant.File.Size || m.Offset != f.Offset || m.Offset+int64(len(payload)) > m.Size {
			return fail(errors.New("RESPONSE_INVALID"))
		}
		out.Metadata = metadata
		raw = payload
		out.BodyBytes = len(raw)
	} else {
		if !strings.HasPrefix(res.Header.Get("Content-Type"), "application/json") {
			return fail(errors.New("RESPONSE_INVALID"))
		}
		if f.Op == "probe" {
			if !json.Valid(payload) {
				return fail(errors.New("RESPONSE_INVALID"))
			}
			out.Result = payload
		} else {
			var r struct {
				OK     bool            `json:"ok"`
				Result json.RawMessage `json:"result"`
			}
			if json.Unmarshal(payload, &r) != nil || !r.OK || len(r.Result) == 0 || r.Result[0] != '{' {
				return fail(errors.New("RESPONSE_INVALID"))
			}
			out.Result = r.Result
		}
	}
	if res.Close {
		s.close()
	}
	out.OK = true
	out.Interface = s.initial.Name
	return out, raw
}
func readFrame(r io.Reader) (frame, []byte, error) {
	var n uint32
	if e := binary.Read(r, binary.BigEndian, &n); e != nil {
		return frame{}, nil, e
	}
	if n == 0 || n > headerLimit {
		return frame{}, nil, errors.New("INVALID_FRAME")
	}
	data := make([]byte, n)
	if _, e := io.ReadFull(r, data); e != nil {
		return frame{}, nil, e
	}
	var f frame
	d := json.NewDecoder(bytes.NewReader(data))
	if d.Decode(&f) != nil || validate(f) != nil {
		return f, nil, errors.New("INVALID_FRAME")
	}
	var trailing any
	if d.Decode(&trailing) != io.EOF {
		return f, nil, errors.New("INVALID_FRAME")
	}
	body := make([]byte, f.BodyBytes)
	_, e := io.ReadFull(r, body)
	return f, body, e
}
func writeReply(w io.Writer, out reply, raw []byte) error {
	data, e := json.Marshal(out)
	if e != nil || len(data) > 65536 {
		return errors.New("INVALID_REPLY")
	}
	if e = binary.Write(w, binary.BigEndian, uint32(len(data))); e != nil {
		return e
	}
	if _, e = w.Write(data); e != nil {
		return e
	}
	_, e = w.Write(raw)
	return e
}
func run(r io.Reader, w io.Writer, s *session) error {
	defer s.close()
	for {
		f, body, e := readFrame(r)
		if e == io.EOF {
			return nil
		}
		if e != nil {
			writeReply(w, reply{Code: "INVALID_FRAME"}, nil)
			return e
		}
		out, raw := s.request(f, body)
		if e = writeReply(w, out, raw); e != nil {
			return e
		}
	}
}
func main() {
	if len(os.Args) != 1 || os.Getuid() != os.Geteuid() {
		os.Exit(2)
	}
	if e := run(os.Stdin, os.Stdout, &session{routeFn: currentRoute, dialFn: physicalDial, controlDialFn: controlDial, controlEnabled: runtime.GOOS == "windows"}); e != nil {
		os.Exit(1)
	}
}
