# Betrieb – C172 Web auf Debian 13

Rein statische Website hinter nginx aus den Debian-Paketquellen. Kein Backend, keine Laufzeit-Abhängigkeiten auf
dem Server außer nginx.

## Verzeichnisse

```
/var/www/c172/
├── releases/
│   ├── 20260923080000/      # vollständiges Release: index.html, css/, js/, vendor/
│   └── 20260924120000/
├── current -> releases/20260924120000     # Webroot von nginx (Symlink)
└── previous -> releases/20260923080000    # zuletzt aktives Release (Rollback-Ziel)
/etc/nginx/sites-available/c172            # = deploy/nginx.conf
/etc/nginx/sites-enabled/c172 -> ../sites-available/c172
```

Dateien gehören `root` (0644/0755); nginx (`www-data`) liest nur. Tests, SPEC/PLAN, `.git` usw. werden nicht
hochgeladen, und versteckte Pfade liefert nginx zusätzlich nie aus.

## Ausrollen

```sh
# inventory.ini:  [c172]  web1.example.org ansible_user=admin
ansible-playbook -i inventory.ini deploy/ansible/playbook.yml
```

Das Playbook
1. installiert nginx,
2. lädt das Release vollständig nach `releases/<UTC-Zeitstempel>/` hoch,
3. prüft Pflichtdateien (`index.html`, `css/app.css`, `js/boot.js`, `js/main.js`, `vendor/three/*.js`) und `nginx -t`,
4. merkt sich das bisher aktive Release als Symlink `previous` und schaltet `current` **atomar** um
   (`ln -sfn … current.tmp && mv -T current.tmp current`), lädt nginx bei Konfigurationsänderungen neu,
5. behält die 5 neuesten Releases und entfernt ältere – `current` und `previous` nie.

Schlägt ein Prüfschritt fehl, bleibt `current` unverändert auf dem alten Release.

## Rollback

```sh
ansible-playbook -i inventory.ini deploy/ansible/playbook.yml --tags rollback
```

stellt `current` atomar auf das zuletzt aktive Release (`previous`) zurück und tauscht beide – ein zweiter
Rollback macht den ersten rückgängig. Ein nie aktiviertes (fehlgeschlagenes) Release wird so nie ausgewählt; kein
nginx-Reload nötig, der Symlink wird pro Anfrage aufgelöst. Von Hand auf dem Server:

```sh
cd /var/www/c172
ls -1 releases/                                   # Releases anzeigen
ln -sfn "$PWD/releases/<release-id>" current.tmp && mv -T current.tmp current
```

## Prüfen

```sh
nginx -t
curl -sI http://localhost/                               # 200, Cache-Control: no-cache
curl -sI -H 'Accept-Encoding: gzip' http://localhost/js/main.js  # text/javascript, gzip, no-cache, ETag
curl -sI http://localhost/vendor/three/three.module.js   # text/javascript, immutable (1 Jahr)
curl -sI http://localhost/gibt-es-nicht.js               # 404 (kein SPA-Fallback)
```

In den Browser-Devtools (Netzwerk): nach dem Laden **keine** Anfragen an fremde Hosts.

Container-Prüfung (Deploy von zwei Releases, Rollback, `nginx -t`, MIME/gzip/Cache-Header, 404):

```sh
docker run --rm -v "$PWD":/src:ro debian:trixie bash -c '
  apt-get update -qq && apt-get install -y -qq ansible-core curl >/dev/null &&
  cd /src && ansible-playbook -i localhost, -c local deploy/ansible/playbook.yml && nginx -t'
```

Stand: `ansible-playbook --syntax-check` ist geprüft; der Container-Lauf steht noch aus (der Docker-Daemon hing
beim Image-Download).

## Caching

| Pfad | Cache-Control | Grund |
|---|---|---|
| `index.html`, `js/**`, `css/**` | `no-cache` (Revalidierung per ETag → meist 304) | Dateinamen sind nicht inhaltsadressiert |
| `vendor/three/**` | `public, max-age=31536000, immutable` | gepinnte three-Version 0.186.0 |

Bei einem three-Upgrade den Pfad versionieren (z. B. `vendor/three-0.187.0/` und Importmap anpassen) oder den
`immutable`-Eintrag in `nginx.conf` vorübergehend entfernen – sonst behalten Browser die alte Datei.

## HTTPS

Noch offen, bis Domain und Infrastruktur feststehen. `nginx.conf` dokumentiert beide Varianten:

- **A – vorhandener Reverse-Proxy** terminiert TLS: diesen Server auf Port 80 lassen, `set_real_ip_from` setzen.
- **B – nginx selbst** mit certbot, empfohlen: `mkdir -p /var/www/letsencrypt && certbot certonly --webroot -w /var/www/letsencrypt -d <domain>`
  und den auskommentierten 443-Block in `deploy/nginx.conf` aktivieren (TLS bleibt Teil des Repos). Wer
  `certbot --nginx` verwendet (ändert die Site-Datei auf dem Server), rollt danach mit
  `-e nginx_site_managed=false` aus – sonst überschreibt das Playbook die TLS-Ergänzungen.

## Logs

`/var/log/nginx/c172.access.log`, `/var/log/nginx/c172.error.log`
