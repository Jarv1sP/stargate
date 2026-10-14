package main

const ticketTTLSeconds = 300
const ticketClockSkewSeconds = 120

// This bounds client clock differences without extending the signed expiry
// enforced by the node. Issuance metadata, when supplied, must be consistent.
func validGrantTime(g grant, now int64) bool {
	if g.Expires <= 0 || g.Expires > maxInteger || g.Expires <= now-ticketClockSkewSeconds {
		return false
	}
	if g.IssuedAt == nil && g.TTL == nil {
		return g.Expires <= now+ticketTTLSeconds+ticketClockSkewSeconds
	}
	return g.IssuedAt != nil && g.TTL != nil && *g.IssuedAt >= 0 && *g.IssuedAt <= maxInteger-ticketTTLSeconds &&
		*g.TTL > 0 && *g.TTL <= ticketTTLSeconds && g.Expires == *g.IssuedAt+*g.TTL && *g.IssuedAt <= now+ticketClockSkewSeconds
}
