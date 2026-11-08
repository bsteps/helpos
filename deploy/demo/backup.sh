#!/bin/sh
# Dumps the helpos database once a day (compressed custom format) and keeps the newest
# $BACKUP_KEEP dumps. Roles aren't in it: postgres-init.sh recreates them from .env, so a restore
# needs the same .env. A failed dump is logged, never kept, and retried the next day.
set -u
# The dumps hold every workspace's data: readable by root only.
umask 077
while true; do
  file="/backups/helpos-$(date -u +%Y%m%dT%H%M%SZ).dump"
  if pg_dump --format=custom --dbname=helpos --file="$file.part"; then
    mv "$file.part" "$file"
    echo "backup written: $file"
  else
    rm -f "$file.part"
    echo "backup FAILED" >&2
  fi
  ls -1t /backups/helpos-*.dump 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | xargs -r rm -f
  sleep 86400
done
