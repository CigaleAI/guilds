#!/usr/bin/env bash
# Fails when a package's eslint-suppressions.json grows outside a rule commit. The total of a
# suppressions file is the sum of its counts. A commit may raise a package's total only when every
# file it changes is a suppressions file, an ESLint configuration (`eslint.*.js`) or a Markdown page
# under docs/: the commit that adds a rule records the errors that predate it and nothing else.
#
# It checks each commit of the branch against its parent, from the merge base with origin/main (or
# main when there is no origin/main) to HEAD, then the working tree against HEAD. A merge may hold
# no more than its parents bring in. On main, no commit is compared.
#
#   scripts/check-suppressions.sh [<tree>]   the tree defaults to the current directory
set -euo pipefail

root="$(git -C "${1:-.}" rev-parse --show-toplevel)"
status=0

# The total of a suppressions file at a revision, or in the working tree when the revision is
# empty; 0 where the file does not exist.
total() {
  local rev="$1" path="$2"
  if [[ -n "$rev" ]]; then
    git -C "$root" show "$rev:$path" 2>/dev/null || true
  else
    cat "$root/$path" 2>/dev/null || true
  fi | node -e '
    const text = require("fs").readFileSync(0, "utf8");
    let sum = 0;
    if (text.trim()) {
      for (const rules of Object.values(JSON.parse(text))) {
        for (const rule of Object.values(rules)) sum += rule.count;
      }
    }
    console.log(sum);
  '
}

is_suppressions() { [[ "${1##*/}" == eslint-suppressions.json ]]; }

# A file a rule commit may change.
is_rule_file() {
  is_suppressions "$1" || [[ "${1##*/}" == eslint.*.js || "$1" == docs/*.md ]]
}

fail() {
  echo "$1: $2 grows from $3 to $4 suppressions; only a commit that adds a rule adds entries, and it changes nothing but suppressions files, ESLint configurations and docs pages"
  status=1
}

# Compares one change, given as `git diff --name-status -M` lines on stdin, from the old revision
# to the new one (the working tree when empty).
compare() {
  local label="$1" old="$2" new="$3" kind first second
  local rule_only=true
  local -a pairs=()
  while IFS=$'\t' read -r kind first second; do
    [[ -n "$kind" ]] || continue
    # A rename names the old path, then the new one.
    if ! is_rule_file "$first" || { [[ -n "$second" ]] && ! is_rule_file "$second"; }; then
      rule_only=false
    fi
    if [[ -n "$second" ]] && is_suppressions "$second"; then
      pairs+=("$first"$'\t'"$second")
    elif is_suppressions "$first"; then
      pairs+=("$first"$'\t'"$first")
    fi
  done
  [[ "$rule_only" == false ]] || return 0
  local pair before after
  for pair in ${pairs[@]+"${pairs[@]}"}; do
    before="$(total "$old" "${pair%%$'\t'*}")"
    after="$(total "$new" "${pair#*$'\t'}")"
    if ((after > before)); then fail "$label" "$(dirname "${pair#*$'\t'}")" "$before" "$after"; fi
  done
}

# A merge holds at most its first parent's entries plus what each other parent adds over its merge
# base with the first.
compare_merge() {
  local commit="$1" label="$2" first="$3"
  shift 3
  local path parent base expected after
  local -a parents=("$@")
  while read -r path; do
    is_suppressions "$path" || continue
    expected="$(total "$first" "$path")"
    for parent in "${parents[@]}"; do
      base="$(git -C "$root" merge-base "$first" "$parent")"
      expected=$((expected + $(total "$parent" "$path") - $(total "$base" "$path")))
    done
    after="$(total "$commit" "$path")"
    if ((after > expected)); then fail "$label" "$(dirname "$path")" "$expected" "$after"; fi
  done < <(for parent in "$first" "${parents[@]}"; do
    git -C "$root" diff --name-only --no-renames "$parent" "$commit"
  done | sort -u)
}

main_ref=""
for ref in origin/main main; do
  if git -C "$root" rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
    main_ref="$ref"
    break
  fi
done

if [[ -n "$main_ref" ]] && base="$(git -C "$root" merge-base "$main_ref" HEAD)"; then
  while read -r commit parent merged; do
    # A root commit has nothing to compare against.
    [[ -n "$parent" ]] || continue
    label="$(git -C "$root" log -1 --format='%h %s' "$commit")"
    if [[ -n "$merged" ]]; then
      read -ra others <<<"$merged"
      compare_merge "$commit" "$label" "$parent" "${others[@]}"
    else
      compare "$label" "$parent" "$commit" < <(git -C "$root" diff --name-status -M "$parent" "$commit")
    fi
  done < <(git -C "$root" rev-list --reverse --parents "$base..HEAD")
fi

compare "working tree" HEAD "" < <(
  git -C "$root" diff --name-status -M HEAD
  git -C "$root" ls-files --others --exclude-standard | awk '{ print "A\t" $0 }'
)

exit "$status"
