#!/usr/bin/env python3
"""Drives the emulator through an installed workos-python, whichever major is installed, so a
release of the SDK that changes what it sends shows up before a user reports it.

Usage:
    python scripts/sdk-smoke-python.py          # starts `node dist/cli.js` itself; build first

Environment:
    EMULATOR_PORT   Port to start the emulator on (default 4190).
"""

import os
import subprocess
import sys
import time
import urllib.request
from importlib.metadata import version

from workos import WorkOSClient

PORT = int(os.environ.get("EMULATOR_PORT", "4190"))
BASE_URL = f"http://localhost:{PORT}/"
API_KEY = "sk_test_default"


def wait_for_emulator() -> None:
    for _ in range(100):
        try:
            with urllib.request.urlopen(f"{BASE_URL}health", timeout=1) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.2)
    raise SystemExit("the emulator did not come up")


def main() -> None:
    emulator = subprocess.Popen(["node", "dist/cli.js", "--port", str(PORT)])
    try:
        wait_for_emulator()
        client = WorkOSClient(api_key=API_KEY, client_id="client_test", base_url=BASE_URL)

        org = client.organizations.create_organization(name="Acme Corp")
        assert client.organizations.get_organization(org.id).name == "Acme Corp"
        assert any(o.id == org.id for o in client.organizations.list_organizations().data)

        created = []
        for i in (1, 2, 3):
            user = client.user_management.create_user(email=f"sdk-{i}@example.com", email_verified=True)
            created.append(user.id)
        membership = client.organization_membership.create_organization_membership(
            user_id=created[0], organization_id=org.id
        )
        assert membership.organization_id == org.id
        memberships = client.organization_membership.list_organization_memberships(user_id=created[0]).data
        assert [m.organization_id for m in memberships] == [org.id]

        # Events are a forward-only log, oldest first, whatever the SDK's default `order` is.
        events = client.events.list_events(events=["user.created"]).data
        listed = [e.data.id for e in events if e.data.id in created]
        assert listed == created, f"user.created events come back oldest first: {listed} != {created}"

        print(f"sdk-smoke-python: OK (workos {version('workos')})")
    finally:
        emulator.terminate()
        emulator.wait(timeout=10)


if __name__ == "__main__":
    sys.exit(main())
