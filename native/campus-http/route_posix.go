//go:build linux || darwin

package main

import (
	"context"
	"errors"
	"net"
	"strconv"
	"syscall"
	"time"
)

// Both hosts keep the existing private-IPv4, interface-bound campus transport.
// Only the socket option used to bind the selected interface is OS-specific.
func physicalDial(ctx context.Context, r route, host, port string) (net.Conn, error) {
	ips, e := net.DefaultResolver.LookupIP(ctx, "ip4", host)
	if e != nil {
		return nil, errors.New("DNS_FAILED")
	}
	var address net.IP
	for _, ip := range ips {
		if ip.To4() != nil && ip.IsPrivate() {
			address = ip
			break
		}
	}
	if address == nil {
		return nil, errors.New("CAMPUS_ADDRESS_REQUIRED")
	}
	nic, e := net.InterfaceByIndex(r.Index)
	if e != nil || nic.Name != r.Name {
		return nil, errors.New("NETWORK_CHANGED")
	}
	dialer := net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second, Control: func(network, address string, c syscall.RawConn) error {
		var bindErr error
		if e := c.Control(func(fd uintptr) { bindErr = bindPhysicalInterface(fd, r) }); e != nil || bindErr != nil {
			return errors.New("PHYSICAL_BIND_DENIED")
		}
		return nil
	}}
	if _, e = strconv.Atoi(port); e != nil {
		return nil, errors.New("INVALID_ORIGIN")
	}
	conn, e := dialer.DialContext(ctx, "tcp4", net.JoinHostPort(address.String(), port))
	if e != nil {
		return nil, dialFailure(e)
	}
	return conn, nil
}
