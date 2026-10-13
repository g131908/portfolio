import pytest

from itkit import onboard


def test_umlauts_are_transliterated_german_style():
    assert onboard.ascii_slug("Müller") == "mueller"
    assert onboard.ascii_slug("Weiß") == "weiss"
    assert onboard.ascii_slug("O'Brien") == "obrien"
    assert onboard.ascii_slug("José") == "jose"


def test_usernames_are_unique():
    taken = set()
    a = onboard.make_username("Anna", "Müller", taken)
    b = onboard.make_username("Anna", "Mueller", taken)
    assert (a, b) == ("anna.mueller", "anna.mueller2")


def test_existing_usernames_are_respected():
    assert onboard.make_username("Jo", "Doe", {"jo.doe"}) == "jo.doe2"


def test_username_length_is_capped_including_suffix():
    taken = set()
    first = onboard.make_username("Konstantinos", "Papadopoulos", taken, max_len=20)
    second = onboard.make_username("Konstantinos", "Papadopoulos", taken, max_len=20)
    assert len(first) <= 20 and len(second) <= 20 and first != second


@pytest.mark.parametrize("_", range(20))
def test_password_meets_complexity(_):
    pw = onboard.make_password(16)
    assert len(pw) == 16
    assert any(c.islower() for c in pw) and any(c.isupper() for c in pw)
    assert any(c.isdigit() for c in pw) and any(not c.isalnum() for c in pw)
    assert not set(pw) & set("Il1O0")


def test_short_passwords_are_refused():
    with pytest.raises(ValueError):
        onboard.make_password(8)


def test_missing_columns_are_reported(tmp_path):
    f = tmp_path / "hires.csv"
    f.write_text("first_name,last_name\nA,B\n")
    with pytest.raises(ValueError, match="department"):
        onboard.read_hires(f)


def test_powershell_quotes_apostrophes():
    acc = onboard.build_accounts(
        [{"first_name": "Sean", "last_name": "O'Brien", "department": "IT"}], "example.com")
    script = onboard.powershell_script(acc, "OU=Users,DC=example,DC=com")
    assert "-Surname 'O''Brien'" in script
    assert "sean.obrien@example.com" in script


def test_write_outputs_creates_files(tmp_path):
    acc = onboard.build_accounts(
        [{"first_name": "Eleni", "last_name": "Papa", "department": "Finance"}], "example.com")
    files = onboard.write_outputs(acc, tmp_path, "linux", "")
    assert [f.name for f in files] == ["accounts.csv", "create_users.sh"]
    assert "useradd -m -s /bin/bash -G finance" in files[1].read_text()
