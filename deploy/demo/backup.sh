#!/bin/sh
# Once a day: dumps the helpos database (compressed custom format) and archives the files volume
# (raw emails and attachments, which the database only points to), under one timestamp. Keeps
# the newest $BACKUP_KEEP of each. Roles aren't in it: docker/postgres/init.sql recreates them
# from .env, so a restore needs the same .env. A failed dump is logged, never kept, and retried
# the next day.
set -u
# The dumps hold every workspace's data: readable by root only.
umask 077
while true; do
  stamp="/backups/helpos-$(date -u +%Y%m%dT%H%M%SZ)"
  # Database first. The server writes a file before the row that points at it, so every row in
  # the snapshot already has its file on disk, and the archive after it includes that file.
  # Files that came in later are only extra.
  if pg_dump --format=custom --dbname=helpos --file="$stamp.dump.part" &&
    tar -czf "$stamp.files.tar.gz.part" -C /files .; then
    # The dump is renamed last: a finished .dump means its files archive is finished too.
    mv "$stamp.files.tar.gz.part" "$stamp.files.tar.gz"
    mv "$stamp.dump.part" "$stamp.dump"
    echo "backup written: $stamp"
  else
    rm -f "$stamp".*.part
    echo "backup FAILED" >&2
  fi
  for kind in dump files.tar.gz; do
    ls -1t /backups/helpos-*."$kind" 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | xargs -r rm -f
  done
  sleep 86400
done
