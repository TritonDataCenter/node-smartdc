#
# Copyright (c) 2013, Joyent, Inc. All rights reserved.
#
# Makefile: basic Makefile for template API service
#
# This Makefile is a template for new repos. It contains only repo-specific
# logic and uses included makefiles to supply common targets (javascriptlint,
# jsstyle, restdown, etc.), which are used by other repos as well. You may well
# need to rewrite most of this file, but you shouldn't need to touch the
# included makefiles.
#
# If you find yourself adding support for new targets that could be useful for
# other projects too, you should add these to the original versions of the
# included Makefiles (in eng.git) so that other teams can use them too.
#

#
# Tools
#
TAP		:= ./node_modules/.bin/tap

#
# Files
#
JS_FILES	:= $(shell find lib test -name '*.js') $(shell find bin -name 'sdc-*')
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE   = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS    = -o indent=4,doxygen,unparenthesized-return=0

include ./tools/mk/Makefile.defs

.PHONY: all
all $(TAP):
	npm install

CLEAN_FILES += ./node_modules

.PHONY: test
test: $(TAP)
	TAP=1 $(TAP) test/*.test.js


# Ensure all version-carrying files have the same version.
.PHONY: check-version
check-version:
	@[[ `cat package.json | json version` == `grep '^## ' CHANGES.md | head -1 | awk '{print $$2}'` ]] \
		|| (echo "check-version error: CHANGES.md top section version does not match package.json#version: $(shell cat package.json | json version)" && exit 2)
	@echo Version check ok.

check:: check-version


include ./tools/mk/Makefile.deps
include ./tools/mk/Makefile.targ
