.PHONY: check hardware apply

check: ## Lint the shell scripts
	shellcheck scripts/*.sh
	bash -n scripts/*.sh

hardware: ## Check that the controller is detected and Mixxx is configured
	./scripts/check-hardware.sh

apply: ## Write the Mixxx sound and controller configuration
	./scripts/apply-mixxx-config.sh
