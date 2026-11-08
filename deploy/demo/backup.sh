#!/bin/sh
# Dumps the whole cluster once a day (roles included, so a restore needs nothing else) and keeps
# the newest $BACKUP_KEEP dumps. A failed dump is logged, never kept, and retried the next day.
set -u
# The dumps hold every workspace's data: readable by root only.
umask 077
while true; do
  file="/backups/helpos-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
  if pg_dumpall --clean --if-exists | gzip > "$file.part"; then
    mv "$file.part" "$file"
    echo "backup written: $file"
  else
    rm -f "$file.part"
    echo "backup FAILED" >&2
  fi
  ls -1t /backups/helpos-*.sql.gz 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | xargs -r rm -f
  sleep 86400
done
