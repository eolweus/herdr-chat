#!/usr/bin/env zsh
set -euo pipefail

root=${0:A:h:h}
engine=$root/engine
hosts=${HERDR_CHAT_HOSTS:-127.0.0.1}

cd $engine
bun install >/dev/null

bun=$(command -v bun)
run="export PATH='$HOME/.local/bin:$PATH'; cd '$engine' && HERDR_CHAT_HOSTS='$hosts' exec '$bun' run index.ts"

if [[ $(uname) == Darwin ]]; then
  plist=~/Library/LaunchAgents/com.herdr-chat.engine.plist
  mkdir -p ~/Library/LaunchAgents ~/Library/Logs
  cat > $plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.herdr-chat.engine</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-lc</string><string>$run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/herdr-chat.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/herdr-chat.log</string>
</dict>
</plist>
EOF
  launchctl bootout gui/$(id -u)/com.herdr-chat.engine 2>/dev/null || true
  launchctl bootstrap gui/$(id -u) $plist
  echo "engine: launchd com.herdr-chat.engine, log ~/Library/Logs/herdr-chat.log"
else
  unit=~/.config/systemd/user/herdr-chat.service
  mkdir -p ${unit:h}
  cat > $unit <<EOF
[Unit]
Description=herdr-chat engine

[Service]
ExecStart=/usr/bin/zsh -lc "$run"
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now herdr-chat.service >/dev/null
  systemctl --user restart herdr-chat.service
  echo "engine: systemd herdr-chat.service, log: journalctl --user -u herdr-chat"
fi

mods=~/.config/herdr-app/mods
if [[ -d $mods ]]; then
  ln -sfn $root/mod $mods/herdr-chat
  echo "mod: linked $mods/herdr-chat"
fi

for _ in {1..20}; do [[ -s ~/.config/herdr-chat/token ]] && break; sleep 0.25; done
[[ -s ~/.config/herdr-chat/token ]] && echo "token: ~/.config/herdr-chat/token" || echo "token: not written yet, check the log"
