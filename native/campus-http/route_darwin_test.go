//go:build darwin

package main

import (
	"net"
	"syscall"
	"testing"
)

func darwinRouteFixture(destination, mask [4]byte, flags int32) *syscall.RouteMessage {
	var data []byte
	for _, ip := range [][4]byte{destination, {192, 0, 2, 1}, mask} {
		address := make([]byte, 16)
		address[0], address[1] = 16, syscall.AF_INET
		copy(address[4:8], ip[:])
		data = append(data, address...)
	}
	return &syscall.RouteMessage{Header: syscall.RtMsghdr{Index: 4, Flags: flags,
		Addrs: syscall.RTA_DST | syscall.RTA_GATEWAY | syscall.RTA_NETMASK}, Data: data}
}

func TestDarwinRoutingSockaddrs(t *testing.T) {
	flags := int32(syscall.RTF_UP | syscall.RTF_GATEWAY)
	m := darwinRouteFixture([4]byte{}, [4]byte{}, flags)
	r, ok := darwinDefaultRoute(m)
	if !ok || r.Index != 4 || r.Gateway != "192.0.2.1" || r.Metric != 0 {
		t.Fatal(r, ok)
	}
	m.Header.Flags |= syscall.RTF_IFSCOPE
	if scoped, ok := darwinDefaultRoute(m); !ok || scoped.Metric != 1<<32 {
		t.Fatal(scoped, ok)
	}
	for _, m := range []*syscall.RouteMessage{
		darwinRouteFixture([4]byte{10}, [4]byte{255}, flags),
		darwinRouteFixture([4]byte{}, [4]byte{128}, flags),
		darwinRouteFixture([4]byte{}, [4]byte{}, flags|syscall.RTF_HOST),
		darwinRouteFixture([4]byte{}, [4]byte{}, flags|syscall.RTF_REJECT),
		darwinRouteFixture([4]byte{}, [4]byte{}, flags|syscall.RTF_BLACKHOLE),
		darwinRouteFixture([4]byte{}, [4]byte{}, syscall.RTF_GATEWAY),
	} {
		if _, ok := darwinDefaultRoute(m); ok {
			t.Fatal("non-default or inactive route accepted")
		}
	}
}

func TestDarwinSocketInterfaceBinding(t *testing.T) {
	nic, err := net.InterfaceByName("lo0")
	if err != nil {
		t.Fatal(err)
	}
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM, syscall.IPPROTO_TCP)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(fd)
	if err := bindPhysicalInterface(uintptr(fd), route{Index: nic.Index, Name: nic.Name}); err != nil {
		t.Fatal(err)
	}
	index, err := syscall.GetsockoptInt(fd, syscall.IPPROTO_IP, syscall.IP_BOUND_IF)
	if err != nil || index != nic.Index {
		t.Fatal(index, err)
	}
}
