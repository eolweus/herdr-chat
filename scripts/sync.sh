#!/usr/bin/env zsh
set -euo pipefail

host=${1:?usage: sync.sh <ssh host>}
root=${0:A:h:h}
addr=$(ssh -G $host | awk '/^hostname /{print $2}')

rsync -a --delete --exclude node_modules --exclude .git --exclude 'test/fixtures' $root/ $host:projects/herdr-chat/
ssh $host "HERDR_CHAT_HOSTS=127.0.0.1,$addr zsh -lc '~/projects/herdr-chat/scripts/install.sh'"
