#!/usr/bin/env bash
# Full verification: build, unit tests, offline check, browser tests on the
# synthetic sample + edge cases, and an independent pandas cross-check.
#
#   tests/run_all.sh                     # synthetic data only
#   tests/run_all.sh path/to/export.csv  # also check a real export (results go
#                                        # to a temp dir outside the repo)
# Needs: python3 + pandas + numpy, node + playwright (Chromium).
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=tests/output
mkdir -p "$OUT"
fails=0
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
run() { "$@" || { fails=$((fails + 1)); echo "   ^ FAILED: $*"; }; }

step "Build"
run python3 build.py

step "Unit tests (parse + metrics)"
run node --test --test-reporter=spec tests/unit.test.mjs

step "Offline check: no external URLs in src / href / fetch / url() / @import"
hits=$(grep -noE '(src|href|action)\s*=\s*["'"'"']?\s*(https?:)?//|fetch\(\s*["'"'"'`]\s*(https?:)?//|url\(\s*["'"'"']?\s*(https?:)?//|@import' dashboard.html || true)
if [ -n "$hits" ]; then echo "$hits"; fails=$((fails + 1)); else echo "PASS  0 external references in dashboard.html"; fi
grep -q "connect-src 'none'" dashboard.html && echo "PASS  Content-Security-Policy blocks all network requests" || { echo "FAIL  CSP missing"; fails=$((fails + 1)); }

step "Browser: synthetic 12-month sample (file://, offline, every control exercised, PDF)"
run node tests/e2e.mjs sample-data/sample_transactions.csv --out "$OUT" --name sample --expect-unit month --interact --pdf
run python3 tests/verify_metrics.py sample-data/sample_transactions.csv "$OUT/sample.json"

step "Browser: edge cases"
run node tests/e2e.mjs tests/fixtures/span_90_days.csv --out "$OUT" --expect-unit week --interact
run python3 tests/verify_metrics.py tests/fixtures/span_90_days.csv "$OUT/span_90_days.json"
run node tests/e2e.mjs tests/fixtures/span_5_years.csv --out "$OUT" --expect-unit quarter --interact
run python3 tests/verify_metrics.py tests/fixtures/span_5_years.csv "$OUT/span_5_years.json"
run node tests/e2e.mjs tests/fixtures/one_customer.csv --out "$OUT" --expect-unit week --interact
run python3 tests/verify_metrics.py tests/fixtures/one_customer.csv "$OUT/one_customer.json"
run node tests/e2e.mjs tests/fixtures/missing_status_column.csv --out "$OUT" --expect-error "Missing required column: Status"
run node tests/e2e.mjs tests/fixtures/malformed_quote.csv --out "$OUT" --expect-error "Unterminated quoted field starting on line 3"
run node tests/e2e.mjs tests/fixtures/iso_dates.csv --out "$OUT" --expect-error "expected DD/MM/YYYY"
run node tests/e2e.mjs tests/fixtures/not_a_csv.csv --out "$OUT" --expect-error "does not look like a CSV"

if [ "${1:-}" != "" ]; then
  step "Browser + pandas: $(basename "$1") (results kept outside the repo)"
  REAL=$(mktemp -d)
  run node tests/e2e.mjs "$1" --out "$REAL" --name real --interact
  run python3 tests/verify_metrics.py "$1" "$REAL/real.json"
  echo "   results: $REAL"
fi

step "Result"
if [ "$fails" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$fails CHECK GROUP(S) FAILED"; fi
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
