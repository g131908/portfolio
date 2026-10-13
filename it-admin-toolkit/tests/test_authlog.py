from pathlib import Path

from itkit import authlog

LOG = Path(__file__).parent.parent / "examples" / "auth.log"


def report():
    with open(LOG) as f:
        return authlog.parse(f)


def test_counts_failures_per_ip():
    r = report()
    assert r.failed_by_ip["203.0.113.45"] == 6
    assert r.failed_by_ip["198.51.100.7"] == 5


def test_threshold_filters_noise():
    ips = [ip for ip, _ in report().suspicious(threshold=5)]
    assert "192.0.2.10" not in ips
    assert set(ips) == {"203.0.113.45", "198.51.100.7"}


def test_flags_success_after_bruteforce():
    hits = report().compromised_candidates(threshold=5)
    assert hits == [{"user": "deploy", "ip": "198.51.100.7", "method": "password"}]


def test_invalid_usernames_collected():
    assert report().invalid_users["admin"] == 1


def test_firewall_commands():
    assert authlog.firewall_commands(["1.2.3.4"]) == "sudo ufw deny from 1.2.3.4 to any port 22"
