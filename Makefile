UUID := $(shell sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' metadata.json)
ZIP  := dist/$(UUID).shell-extension.zip

.PHONY: all pack install uninstall enable disable prefs nested clean

all: pack

pack: $(ZIP)

# The light style is the dark one with the colors in theme/light.css on top.
stylesheet-light.css: stylesheet.css theme/light.css
	cat stylesheet.css theme/light.css > $@

$(ZIP): metadata.json extension.js prefs.js stylesheet.css stylesheet-light.css $(wildcard lib/*.js) $(wildcard icons/*) $(wildcard schemas/*.xml)
	@mkdir -p dist
	gnome-extensions pack --force --out-dir=dist \
		--extra-source=lib --extra-source=icons --extra-source=stylesheet-light.css --extra-source=LICENSE .

install: pack
	gnome-extensions install --force $(ZIP)
	glib-compile-schemas $${XDG_DATA_HOME:-$$HOME/.local/share}/gnome-shell/extensions/$(UUID)/schemas
	@echo "Installed. On Wayland, log out and back in (or use 'make nested'), then 'make enable'."

uninstall:
	gnome-extensions uninstall $(UUID)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

prefs:
	gnome-extensions prefs $(UUID)

# Test in a nested GNOME Shell window (GNOME 48+ needs the mutter-dev-bin package for --devkit).
nested: install
	@if gnome-shell --help 2>&1 | grep -q -- --devkit; then \
		dbus-run-session -- gnome-shell --devkit --wayland; \
	else \
		dbus-run-session -- gnome-shell --nested --wayland; \
	fi

clean:
	rm -rf dist stylesheet-light.css
