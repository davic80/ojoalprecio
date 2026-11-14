#!/bin/sh
# Chromium with low CPU priority: other services on the host always pass first.
exec nice -n 15 /usr/bin/chromium "$@"
