from datetime import datetime, timezone

from itkit import certs, inventory
from itkit.cli import main


def test_days_until():
    now = datetime(2027, 5, 2, 12, 0, tzinfo=timezone.utc)
    assert certs.days_until("Jun  1 12:00:00 2027 GMT", now) == 30


def test_parse_target_default_port():
    assert certs.parse_target("example.com") == ("example.com", 443)
    assert certs.parse_target("mail.example.com:993") == ("mail.example.com", 993)


def test_cert_levels():
    assert certs.CertStatus("a", 443, ok=True, days_left=90).level() == "OK"
    assert certs.CertStatus("a", 443, ok=True, days_left=10).level() == "WARN"
    assert certs.CertStatus("a", 443, ok=True, days_left=-1).level() == "EXPIRED"
    assert certs.CertStatus("a", 443, ok=False, error="x").level() == "ERROR"


def test_inventory_collects_basics():
    info = inventory.collect()
    assert info["hostname"] and info["cpu_cores"] >= 1
    assert all("used_pct" in d for d in info["disks"])


def test_inventory_warnings():
    info = {"disks": [{"mount": "/", "used_pct": 95.0, "free_gb": 2.0}], "uptime_h": 1000, "memory_gb": 4}
    w = inventory.warnings(info)
    assert len(w) == 3


def test_cli_onboard_end_to_end(tmp_path, capsys):
    csv = tmp_path / "hires.csv"
    csv.write_text("first_name,last_name,department\nAnna,Müller,IT\n", encoding="utf-8")
    code = main(["onboard", str(csv), "-d", "example.com", "-o", str(tmp_path / "out")])
    assert code == 0
    assert "anna.mueller@example.com" in capsys.readouterr().out
    assert (tmp_path / "out" / "create_users.ps1").exists()


def test_cli_reports_errors_cleanly(capsys):
    assert main(["authlog", "does-not-exist.log"]) == 2
    assert "error:" in capsys.readouterr().err
