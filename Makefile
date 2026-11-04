.PHONY: check hardware apply apply-pc

check: ## Lint the shell scripts
	shellcheck scripts/*.sh
	bash -n scripts/*.sh

hardware: ## Check that the controller is detected and Mixxx is configured
	./scripts/check-hardware.sh

apply: ## Mixxx config, sound through the controller's card (speakers on MAIN RCA)
	./scripts/apply-mixxx-config.sh controller

apply-pc: ## Mixxx config, sound through PipeWire (laptop speakers), controller for MIDI only
	./scripts/apply-mixxx-config.sh pc
