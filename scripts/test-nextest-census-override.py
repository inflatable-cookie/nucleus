"""Keep checkout census tests in nextest's serialized override."""

from pathlib import Path
import re
import unittest


CONFIG = Path(__file__).parents[1] / "engine/.config/nextest.toml"
CENSUS_TESTS = (
    "an_external_orphan_in_the_checkout_is_retained_and_holds_retirement",
    "closeout_stops_a_finished_sessions_provider_helpers",
)


class NextestCensusOverrideTest(unittest.TestCase):
    def test_census_tests_require_all_test_threads_in_the_same_override(self):
        text = CONFIG.read_text()
        blocks = re.split(r"(?m)^\[\[profile\.default\.overrides\]\]\s*$", text)[1:]

        for block in blocks:
            filter_match = re.search(r"(?m)^filter\s*=\s*'([^']+)'\s*$", block)
            threads_match = re.search(r"(?m)^threads-required\s*=\s*'([^']+)'\s*$", block)
            if (
                filter_match
                and threads_match
                and threads_match.group(1) == "num-test-threads"
                and all(
                    re.search(rf"test\({re.escape(name)}\)", filter_match.group(1))
                    for name in CENSUS_TESTS
                )
            ):
                return

        self.fail(
            "both census tests must match one default-profile override requiring "
            "num-test-threads"
        )


if __name__ == "__main__":
    unittest.main()
