.PHONY: check hardware apply apply-pc setup mapping

check: ## Lint scripts and validate the mapping files
	shellcheck scripts/*.sh
	bash -n scripts/*.sh
	python3 -I -m py_compile scripts/build-mapping.py
	python3 -I -c "import xml.dom.minidom, glob; [xml.dom.minidom.parse(f) for f in glob.glob('mixxx/**/*.xml', recursive=True)]"
	node --check mixxx/controllers/*.js 2>/dev/null || true

mapping: ## Regenerate the MK2 mapping from the mapping shipped with Mixxx
	python3 -I scripts/build-mapping.py

hardware: ## Check that the controller is detected and Mixxx is configured
	./scripts/check-hardware.sh

apply: ## Mixxx config, sound through the controller's card (speakers on MAIN RCA)
	./scripts/apply-mixxx-config.sh controller

apply-pc: ## Mixxx config, sound through PipeWire (laptop speakers), controller for MIDI only
	./scripts/apply-mixxx-config.sh pc

setup: ## Install Mixxx and real-time limits (needs sudo)
	sudo ./scripts/setup-ubuntu.sh
