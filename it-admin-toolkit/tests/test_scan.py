import socket
import threading

import pytest

from itkit import scan


def test_parse_ports_ranges_and_dedup():
    assert scan.parse_ports("443,22,80-82,22") == [22, 80, 81, 82, 443]


def test_parse_ports_default_is_common_ports():
    assert 22 in scan.parse_ports(None) and 3389 in scan.parse_ports("")


def test_parse_ports_rejects_out_of_range():
    with pytest.raises(ValueError):
        scan.parse_ports("0,70000")


def test_expand_cidr_excludes_network_and_broadcast():
    hosts = scan.expand_targets("10.0.0.0/30")
    assert hosts == ["10.0.0.1", "10.0.0.2"]


def test_expand_refuses_huge_networks():
    with pytest.raises(ValueError, match="limit"):
        scan.expand_targets("10.0.0.0/16")


def test_scan_finds_a_real_listening_port():
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen()
    port = server.getsockname()[1]
    threading.Thread(target=lambda: server.accept(), daemon=True).start()
    try:
        result = scan.scan("127.0.0.1", [port, 1], timeout=0.3, resolve=False)
    finally:
        server.close()
    assert len(result) == 1
    assert result[0].open_ports == [port]
