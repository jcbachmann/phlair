#!/bin/sh
set -e
cd /srv/phorge
bin/config set mysql.host "$MYSQL_HOST"
bin/config set mysql.user root
bin/config set mysql.pass "$MYSQL_PASSWORD"
bin/config set phabricator.base-uri "$BASE_URI"
bin/config set pygments.enabled false
bin/config set phabricator.developer-mode false
# Phlair's library (../../phorge); seed.php turns Phizziwig off by default
# and on for alice.
bin/config set load-libraries '["/srv/phlair/src"]'
# Lets the server download images from the host for the E2E tests (phizziwig.download).
bin/config set security.outbound-blacklist '[]'
# Files on disk, as in production: files over 4 MB are uploaded in chunks,
# which need a storage engine for large files (the database's takes 1 MB).
mkdir -p /var/phorge-files && chown www-data:www-data /var/phorge-files
bin/config set storage.local-disk.path /var/phorge-files
# Files from a domain of their own, as in production (the browser knows
# that *.localhost is this machine).
bin/config set security.alternate-file-domain "$FILE_URI"

until mysqladmin ping -h "$MYSQL_HOST" -uroot -p"$MYSQL_PASSWORD" --silent; do sleep 1; done
bin/storage upgrade --force
php /usr/local/bin/seed.php
# The daemons build the search index that wiki and project autocomplete use.
bin/phd start
exec apache2-foreground
