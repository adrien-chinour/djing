.PHONY: check test hardware apply apply-pc setup mapping agent-mapping demo analyze mix daemon daemon-stop

check: ## Lint scripts and validate the mapping files
	shellcheck scripts/*.sh
	bash -n scripts/*.sh
	python3 -I -m py_compile scripts/build-mapping.py agent/*.py
	python3 -I -c "import xml.dom.minidom, glob; [xml.dom.minidom.parse(f) for f in glob.glob('mixxx/**/*.xml', recursive=True)]"
	node --check mixxx/controllers/*.js 2>/dev/null || true

test: ## Loopback test of the MIDI bridge (no Mixxx needed)
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

mix: ## Step 3: one agent-driven transition (see agent/mix.py for options, e.g. A="super bouncy" B="dreams")
	uv run python -m agent.mix $(if $(A),--a "$(A)") $(if $(B),--b "$(B)") $(if $(BARS),--bars $(BARS)) $(ARGS)

daemon: ## Start the MIDI daemon in the background (owns the djing-agent port; start it before Mixxx)
	@pgrep -f "agent.daemon" >/dev/null && echo "daemon already running" || (setsid nohup uv run python -m agent.daemon > /tmp/djing-daemon.log 2>&1 & sleep 1; cat /tmp/djing-daemon.log)

daemon-stop: ## Stop the MIDI daemon
	pkill -f "agent.daemon" || true
