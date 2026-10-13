# Shared by agent-browser-start, agent-cli-start, and agent-stop, which source it from
# /usr/local/lib/guilds. The orchestrator passes every port; nothing here derives one.

# An agent id, as the orchestrator names its home and run directory.
valid_agent() {
  [[ "${1:-}" =~ ^[A-Za-z0-9_-]{1,64}$ ]]
}

# A port above the privileged range.
valid_port() {
  [[ "${1:-}" =~ ^[0-9]{1,5}$ ]] && (( 10#$1 >= 1024 && 10#$1 <= 65535 ))
}

# An X display number.
valid_display() {
  [[ "${1:-}" =~ ^[0-9]{1,3}$ ]] && (( 10#$1 >= 1 && 10#$1 <= 999 ))
}

# Runs the command every tenth of a second until it succeeds, for at most the given tenths.
wait_until() {
  local tenths="$1"
  shift
  local _
  for _ in $(seq 1 "$tenths"); do
    if "$@"; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

# Whether any live process (not a zombie) belongs to the process group.
group_alive() {
  local pgid="$1" stat line
  local -a fields
  for stat in /proc/[0-9]*/stat; do
    read -r line < "$stat" 2>/dev/null || continue
    # After the command name: state, parent, process group.
    read -ra fields <<< "${line##*) }"
    if [ "${fields[0]}" != Z ] && [ "${fields[2]}" = "$pgid" ]; then
      return 0
    fi
  done
  return 1
}

group_gone() {
  ! group_alive "$1"
}

# Ends a process group: TERM, two seconds, KILL, one second. Fails when it is still alive.
stop_group() {
  local pgid="$1"
  [[ "$pgid" =~ ^[0-9]+$ ]] && (( pgid > 1 )) || return 0
  group_alive "$pgid" || return 0
  kill -TERM -- "-$pgid" 2>/dev/null || true
  wait_until 20 group_gone "$pgid" && return 0
  kill -KILL -- "-$pgid" 2>/dev/null || true
  wait_until 10 group_gone "$pgid"
}

# Ends the process group whose leader's pid the file holds, then removes the file; fails, and
# keeps the file, when the group is still alive.
stop_group_file() {
  local pid_file="$1"
  [ -s "$pid_file" ] || return 0
  if stop_group "$(cat "$pid_file")"; then
    rm -f "$pid_file"
    return 0
  fi
  echo "still running: $pid_file" >&2
  return 1
}
