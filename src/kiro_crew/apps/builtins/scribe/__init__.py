"""Scribe — markdown documents with an embedded agent co-author (prototype).

A deliberately thin vertical slice of the design in
``workspace/markdown-coauthor-design.md``: prove the Papyrus co-author spine
(stock chat slot + ephemeral scoping context + embedded ChatPage +
reload-on-idle) against a markdown document, before investing in the editor,
vault, or context-rail layers.

Documents live under ``~/.kiro/crew/apps/scribe/data/docs/<name>.md`` (via
``app_data_dir``). The agent edits them with its own file tools at the absolute
path the companion context names; this backend only serves the page's own
read/write loop.
"""

# Required re-export: dashboard/server.py's startup route registration imports
# the PACKAGE and checks hasattr(_mod, "register_routes") — the convention
# aws_control/crew_companion/issue_radar follow (the call site is the
# `for _builtin_name in BUILTIN_NAMES` loop). Routes are registered at STARTUP,
# not on enable, which is why every handler carries its own enabled check and
# answers 403 while the app is off.
from kiro_crew.apps.builtins.scribe.backend.routes import (  # noqa: F401
    register_routes,
)
