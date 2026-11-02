# Local Phorge for developing and testing the editor. Phorge upstream
# is frozen since 2021; its last supported PHP is 7.4.
FROM php:7.4-apache

# The image is based on Debian bullseye, which has moved to the archive.
RUN printf 'deb http://archive.debian.org/debian bullseye main\ndeb http://archive.debian.org/debian-security bullseye-security main\n' > /etc/apt/sources.list \
 && rm -f /etc/apt/sources.list.d/*

RUN apt-get update \
 && apt-get install -y --no-install-recommends git libzip-dev libpng-dev libjpeg-dev \
    libfreetype6-dev libcurl4-openssl-dev mariadb-client \
 && rm -rf /var/lib/apt/lists/* \
 && docker-php-ext-configure gd --with-freetype --with-jpeg \
 && docker-php-ext-install mysqli pcntl gd zip opcache curl \
 && pecl install apcu && docker-php-ext-enable apcu \
 && a2enmod rewrite headers

# Exact commits of Phorge's "stable" branch (as of 2026-10), so every build
# tests the same code; update them on purpose. Phorge's server only hands out
# branch tips, so the branch is fetched and the commit checked out of it.
ARG ARCANIST_REPO=https://we.phorge.it/source/arcanist.git
ARG ARCANIST_COMMIT=922ffd9dd8233e29e269bc28c19931a39a0ef46d
ARG PHORGE_REPO=https://we.phorge.it/source/phorge.git
ARG PHORGE_COMMIT=9060b5cdab7fe5376d82187da4a8283aa62137bf
RUN fetch() { git init -q "$4" && git -C "$4" fetch -q "$1" "$2" && git -C "$4" checkout -q "$3"; } \
 && fetch ${ARCANIST_REPO} stable ${ARCANIST_COMMIT} /srv/arcanist \
 && fetch ${PHORGE_REPO} stable ${PHORGE_COMMIT} /srv/phorge

COPY apache.conf /etc/apache2/sites-available/000-default.conf
COPY php.ini /usr/local/etc/php/conf.d/phorge.ini
COPY entrypoint.sh seed.php /usr/local/bin/
WORKDIR /srv/phorge
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
