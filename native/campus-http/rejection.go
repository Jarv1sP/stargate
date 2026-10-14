package main

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

var rejectionCode = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// HTTP 429 is an explicit refusal. Retry the original request within the caller's bounded budget.
func admissionBusyDelay(response *http.Response, payload []byte) int {
	if response.StatusCode != 429 {
		return 0
	}
	seconds, err := strconv.Atoi(response.Header.Get("Retry-After"))
	if err != nil || seconds < 1 || seconds > 120 {
		return 1000
	}
	return seconds * 1000
}

// Only bounded scalar fields cross the IPC boundary. Never return a response
// document, headers, grant, or an error that echoes the opaque capability.
func rejectionDetails(payload []byte, f frame) (string, string) {
	if len(payload) > 4096 {
		return "", ""
	}
	var document map[string]json.RawMessage
	if json.Unmarshal(payload, &document) != nil {
		return "", ""
	}
	private := []string{f.Grant.Ticket, f.Grant.ID}
	private = append(private, strings.Split(f.Grant.Ticket, ".")...)
	safe := func(key string, limit int) string {
		var text string
		if json.Unmarshal(document[key], &text) != nil || !utf8.ValidString(text) || len(text) > limit {
			return ""
		}
		for _, c := range text {
			if unicode.IsControl(c) || unicode.Is(unicode.Cf, c) {
				return ""
			}
		}
		lower := strings.ToLower(text)
		if strings.Contains(lower, "bearer ") || strings.Contains(lower, "private key") || strings.ContainsAny(text, "{}") {
			return ""
		}
		for _, value := range private {
			if len(value) >= 8 && strings.Contains(lower, strings.ToLower(value)) {
				return ""
			}
		}
		return strings.TrimSpace(text)
	}
	code := safe("reasonCode", 64)
	if !rejectionCode.MatchString(code) {
		code = safe("code", 64)
	}
	if !rejectionCode.MatchString(code) {
		code = ""
	}
	return code, safe("error", 512)
}
