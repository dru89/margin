.PHONY: dev build lint package package-linux package-mac clean icons release site-dev

# Start electron-vite with HMR.
dev:
	npm run dev

# Type-check and bundle main/preload/renderer (no packaging).
build:
	npm run typecheck && npx electron-vite build

# Type-check only.
lint:
	npm run typecheck

# Package for the current platform (no publish).
package: build
	npx electron-builder --publish never

package-linux: build
	npx electron-builder --linux --publish never

package-mac: build
	npx electron-builder --mac --publish never

# Remove build artifacts.
clean:
	rm -rf out dist

# Regenerate icon PNGs from the source SVG (requires rsvg-convert).
# macOS icns generation additionally requires sips/iconutil.
icons: build/icon.png build/icon.icns

build/icon.png: build/icon.svg
	@rsvg-convert -w 512 -h 512 $< -o $@
	@for s in 256 128 64 32; do rsvg-convert -w $$s -h $$s $< -o build/$${s}x$${s}.png; done
	@echo "Generated $@ (+ size variants)"

build/icon.icns: build/icon.svg
	@if ! command -v iconutil >/dev/null; then echo "skipping icns (macOS only)"; exit 0; fi
	@mkdir -p /tmp/margin-icon.iconset
	@for s in 16 32 128 256 512; do \
		rsvg-convert -w $$s -h $$s $< -o /tmp/margin-icon.iconset/icon_$${s}x$${s}.png; \
		rsvg-convert -w $$((s*2)) -h $$((s*2)) $< -o /tmp/margin-icon.iconset/icon_$${s}x$${s}@2x.png; \
	done
	@iconutil -c icns /tmp/margin-icon.iconset -o $@
	@rm -rf /tmp/margin-icon.iconset
	@echo "Generated $@"

# Release: bump version, commit, tag, and push. GitHub Actions builds and
# publishes the GitHub Release (see .github/workflows/release.yml).
#
# Usage:
#   make release                  # interactive prompt
#   make release VERSION=patch    # 0.1.0 -> 0.1.1
#   make release VERSION=minor    # 0.1.0 -> 0.2.0
#   make release VERSION=major    # 0.1.0 -> 1.0.0
#   make release VERSION=1.2.3    # explicit version
release:
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "Error: You have uncommitted changes. Please commit or stash them first."; \
		exit 1; \
	fi; \
	CURRENT=$$(node -p "require('./package.json').version"); \
	MAJOR=$$(echo $$CURRENT | cut -d. -f1); \
	MINOR=$$(echo $$CURRENT | cut -d. -f2); \
	PATCH=$$(echo $$CURRENT | cut -d. -f3); \
	NEXT_PATCH="$$MAJOR.$$MINOR.$$((PATCH + 1))"; \
	NEXT_MINOR="$$MAJOR.$$((MINOR + 1)).0"; \
	NEXT_MAJOR="$$((MAJOR + 1)).0.0"; \
	if [ -n "$(VERSION)" ]; then \
		case "$(VERSION)" in \
			patch) NEXT=$$NEXT_PATCH ;; \
			minor) NEXT=$$NEXT_MINOR ;; \
			major) NEXT=$$NEXT_MAJOR ;; \
			*) NEXT="$(VERSION)" ;; \
		esac; \
	else \
		echo "Current version: v$$CURRENT"; \
		echo ""; \
		echo "  1) patch  → v$$NEXT_PATCH"; \
		echo "  2) minor  → v$$NEXT_MINOR"; \
		echo "  3) major  → v$$NEXT_MAJOR"; \
		echo "  4) custom"; \
		echo ""; \
		printf "Choice [1]: "; \
		read CHOICE; \
		CHOICE=$${CHOICE:-1}; \
		case $$CHOICE in \
			1) NEXT=$$NEXT_PATCH ;; \
			2) NEXT=$$NEXT_MINOR ;; \
			3) NEXT=$$NEXT_MAJOR ;; \
			4) printf "Version (without v prefix): "; read NEXT ;; \
			*) echo "Invalid choice"; exit 1 ;; \
		esac; \
	fi; \
	echo ""; \
	echo "Releasing v$$NEXT..."; \
	echo ""; \
	npm version $$NEXT --no-git-tag-version && \
	npm install --package-lock-only && \
	git add package.json package-lock.json && \
	git commit -m "Bump version to $$NEXT" && \
	git tag "v$$NEXT" && \
	git push origin main && \
	git push origin "v$$NEXT"; \
	echo ""; \
	echo "Tagged and pushed v$$NEXT. GitHub Actions will handle the rest."; \
	echo "https://github.com/Dru89/margin/actions"

# Serve the static marketing site locally.
site-dev:
	python -m http.server 8931 -d site
