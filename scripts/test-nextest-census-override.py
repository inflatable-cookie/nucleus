"""Keep checkout census tests in nextest's serialized override."""

import json
import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "engine"
MANIFEST = ENGINE / "Cargo.toml"
CONFIG = ENGINE / ".config/nextest.toml"
CENSUS_TESTS = (
    "an_external_orphan_in_the_checkout_is_retained_and_holds_retirement",
    "closeout_stops_a_finished_sessions_provider_helpers",
)


class NextestCensusOverrideTest(unittest.TestCase):
    def census_override(self):
        text = CONFIG.read_text()
        blocks = re.split(r"(?m)^\[\[profile\.default\.overrides\]\]\s*$", text)[1:]
        for block in blocks:
            filter_match = re.search(r"(?m)^filter\s*=\s*'([^']+)'\s*$", block)
            threads_match = re.search(r"(?m)^threads-required\s*=\s*'([^']+)'\s*$", block)
            if filter_match and threads_match:
                return filter_match.group(1), threads_match.group(1)
        self.fail("default nextest profile has no census override")

    def discovered_matches(self, expression):
        result = subprocess.run(
            [
                "oxide", "exec", "--manifest-path", str(MANIFEST), "--",
                "cargo", "nextest", "list", "--manifest-path", str(MANIFEST),
                "-p", "nucleus-service", "--filterset", expression,
                "--message-format", "json",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode:
            self.fail(f"nextest list failed: {result.stderr}")
        listing = json.loads(result.stdout)
        return {
            name
            for suite in listing.get("rust-suites", {}).values()
            for name, case in suite.get("testcases", {}).items()
            if case.get("filter-match", {}).get("status") == "matches"
        }

    def test_nextest_applies_the_census_filter_to_discovered_tests(self):
        expression, threads_required = self.census_override()
        self.assertEqual(threads_required, "num-test-threads")

        matched = self.discovered_matches(expression)
        selected_census_tests = {
            name.rsplit("::", 1)[-1]
            for name in matched
            if name.rsplit("::", 1)[-1] in CENSUS_TESTS
        }
        self.assertEqual(selected_census_tests, set(CENSUS_TESTS))

    def test_inverted_filter_excludes_both_discovered_census_tests(self):
        expression = (
            "package(nucleus-service) and not ("
            + " or ".join(f"test({name})" for name in CENSUS_TESTS)
            + ")"
        )
        matched = self.discovered_matches(expression)
        selected = {name.rsplit("::", 1)[-1] for name in matched}
        self.assertTrue(set(CENSUS_TESTS).isdisjoint(selected))


if __name__ == "__main__":
    unittest.main()
