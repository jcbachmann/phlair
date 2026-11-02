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

until mysqladmin ping -h "$MYSQL_HOST" -uroot -p"$MYSQL_PASSWORD" --silent; do sleep 1; done
bin/storage upgrade --force
php /usr/local/bin/seed.php
# The daemons build the search index that wiki and project autocomplete use.
bin/phd start
exec apache2-foreground
