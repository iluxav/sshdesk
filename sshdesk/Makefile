# sshdesk — build & run
#
# NOTE: Tauri embeds ui/index.html into the binary at build time.
# Editing the HTML has no effect until you rebuild. Always use `make run`.

BIN     := src-tauri/target/release/sshdesk
PROBE   := core/target/release/sshdesk-probe
HOST    ?= iluxa@10.168.168.226

.PHONY: all run build plugins ui-build ui-install dev probe clean kill restart help

all: run

## run: rebuild (UI + Rust) and launch the app
run: kill build
	@echo "→ launching sshdesk"
	@$(BIN) > /tmp/sshdesk.log 2>&1 &
	@sleep 2
	@pgrep -f 'release/sshdesk$$' >/dev/null \
		&& echo "✓ running — check your screen" \
		|| { echo "✗ crashed:"; cat /tmp/sshdesk.log; exit 1; }

## lint-plugins: catch mistakes that are fatal at runtime
#
# `style="..."` is the one worth a build failure: html`` produces React
# elements, a style string throws React error #62, and that unmounts the app.
# It looks like ordinary HTML, so it is easy to write and easy to miss.
lint-plugins:
	@bad=$$(grep -rn 'style="' plugins/*/index.js plugins/*/src/*.jsx 2>/dev/null || true); \
	if [ -n "$$bad" ]; then \
		echo "✗ style must be an object, not a string (React error #62):"; \
		echo "$$bad"; \
		echo "  use style=\$${{ padding: 16 }} or a class in style.css"; \
		exit 1; \
	fi; \
	echo "✓ plugins lint clean"

## plugins: build any plugin that has its own build step (JSX/TS)
plugins: lint-plugins
	@for d in plugins/*/; do \
		if [ -f "$$d/package.json" ]; then \
			echo "→ building plugin $$(basename $$d)"; \
			(cd "$$d" && npm run --silent build); \
		fi; \
	done

## build: full release build via the Tauri CLI
# Must go through `cargo tauri build`, NOT plain `cargo build`. The CLI runs
# beforeBuildCommand and drives asset embedding; plain cargo silently ships an
# empty page because build.rs is not re-run when only ui/dist changes.
build: plugins
	@echo "→ building (tauri cli: vite + rust + embed)"
	@cd src-tauri && cargo tauri build --no-bundle

## ui-build: compile the React/Vite frontend to ui/dist only
ui-build:
	@echo "→ building ui"
	@npm --prefix ui run build

## ui-install: install frontend dependencies
ui-install:
	@npm --prefix ui install

## dev: hot reload (vite + tauri). Edit .tsx and it updates instantly. Opens devtools.
dev: kill
	@cd src-tauri && cargo tauri dev

## probe: run the headless verification harness against $(HOST)
probe:
	@cargo build --release --manifest-path core/Cargo.toml
	@$(PROBE) $(HOST)

## probe-sudo: same, but also exercise privileged actions
probe-sudo:
	@cargo build --release --manifest-path core/Cargo.toml
	@read -s -p "sudo password for $(HOST): " PW; echo; \
		SSHDESK_PW="$$PW" $(PROBE) $(HOST)

## restart: kill and relaunch without rebuilding
restart: kill
	@$(BIN) > /tmp/sshdesk.log 2>&1 &
	@sleep 2 && echo "✓ relaunched"

## kill: stop any running instance
kill:
	@pkill -f 'release/sshdesk$$' 2>/dev/null || true
	@sleep 1

## clean: remove build artifacts and stale control sockets
clean: kill
	@cargo clean --manifest-path src-tauri/Cargo.toml
	@cargo clean --manifest-path core/Cargo.toml
	@rm -rf ui/dist
	@rm -f $(HOME)/.sshdesk-*.sock
	@echo "✓ cleaned"

## help: list targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## /  /'
