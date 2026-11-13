.PHONY: web web-split web-sim web-test check test hardware apply apply-pc setup mapping agent-mapping demo analyze mix rate daemon daemon-stop visuals visual visuals-image visuals-lint-docker

check: ## Lint scripts and validate the mapping files
	shellcheck scripts/*.sh
	bash -n scripts/*.sh
	python3 -I -m py_compile scripts/build-mapping.py agent/*.py
	python3 -I -c "import xml.dom.minidom, glob; [xml.dom.minidom.parse(f) for f in glob.glob('mixxx/**/*.xml', recursive=True)]"
	node --check mixxx/controllers/*.js 2>/dev/null || true
	shellcheck visuals/switch
	bash -n visuals/switch
	node --check visuals/server.js visuals/public/*.js
	node --check web/*.js web/ui/*.js web/worklets/*.js web/test/*.mjs web/test/scenarios/*.mjs
	node --check web/analysis/*.js
	python3 -I -m py_compile web/sim/controller.py
	@# TV pages must stay ES5 (no let/const/class/arrow functions/template strings)
	@! grep -nE '\b(let|const|class)[[:space:]]+[A-Za-z_$$]|=>|`' visuals/public/*.html visuals/public/scenes/*.html visuals/public/*.js || { echo 'ES5 only in TV files'; exit 1; }

test: ## Offline checks (catalog, patterns) + loopback test of the MIDI bridge, no Mixxx needed
	uv run python -m agent.check_offline
	uv run python -m agent.selftest

mapping: ## Regenerate the MK2 mapping from the mapping shipped with Mixxx
	python3 -I scripts/build-mapping.py

agent-mapping: ## Regenerate the agent mapping (XML + JS table) from agent/protocol.py
	uv run python -m agent.build_mapping

demo: ## Step 1 demo: the agent moves the crossfader and prints Mixxx feedback
	uv run python -m agent.demo_crossfader

hardware: ## Check that the controller is detected and Mixxx is configured
	./scripts/check-hardware.sh

apply: ## Mixxx config, sound through the controller's card (speakers on MAIN RCA)
	./scripts/apply-mixxx-config.sh controller

apply-pc: ## Mixxx config, sound through PipeWire (laptop speakers), controller for MIDI only
	./scripts/apply-mixxx-config.sh pc

setup: ## Install Mixxx and real-time limits (needs sudo)
	sudo ./scripts/setup-ubuntu.sh

analyze: ## Step 2: analyse every track of the Mixxx library into analysis/*.json
	uv run python -m agent.analysis.analyze

mix: ## One improvised transition (A="title" B="title" PATTERN=slam ARGS=--skip-to)
	uv run python -m agent.mix $(if $(A),--a "$(A)") $(if $(B),--b "$(B)") $(if $(PATTERN),--pattern $(PATTERN)) $(ARGS)

rate: ## Rate the last transition: make rate N=4 C="parfait"
	uv run python -m agent.rate $(N) "$(C)"

daemon: ## Start the MIDI daemon in the background (owns the djing-agent port; start it before Mixxx)
	@pgrep -f "agent.daemon" >/dev/null && echo "daemon already running" || (setsid nohup uv run python -m agent.daemon > /tmp/djing-daemon.log 2>&1 & sleep 1; cat /tmp/djing-daemon.log)

daemon-stop: ## Stop the MIDI daemon
	pkill -f "agent.daemon" || true

visuals: ## Visuals: one process for sound analysis, TV pages and control (ARGS="--range 25")
	node visuals/server.js $(ARGS)

visual: ## Visuals: switch the TV to a visual from the terminal (make visual V=terrain)
	./visuals/switch $(V)

visuals-lint-docker: ## Visuals: lint the Dockerfile with hadolint (Docker)
	docker run --rm -i hadolint/hadolint:v2.12.0 < visuals/Dockerfile

visuals-image: ## Visuals: build the remote image and run it on port 8765 (SECRET=... for stable links)
	docker build -t djing-visuals visuals
	docker run --rm -p 8765:8765 -e SESSION_SECRET="$(SECRET)" djing-visuals

web: ## Web DJ proof of concept on http://localhost:8800 (open in Chrome; localhost is needed for Web MIDI)
	python3 -m http.server 8800 --bind 127.0.0.1 --directory web

web-split: ## Split the controller card into two stereo sinks, Inpulse MAIN (1-2) and Inpulse Casque (3-4), for web/
	./scripts/split-outputs.sh

web-sim: ## Simulated controller on a virtual MIDI port, commands on stdin (see web/sim/controller.py)
	uv run python -I web/sim/controller.py

web-test: ## End-to-end test of web/ without hardware, every scenario of web/test/scenarios/ (SCENARIO=poc for one)
	node web/test/e2e.mjs $(SCENARIO)
