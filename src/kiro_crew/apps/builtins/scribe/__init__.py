"""Scribe — markdown documents with an embedded agent co-author.

A thin UI over core capabilities, per ``workspace/markdown-coauthor-rfc.md``:
documents are markdown-kind artifacts tagged ``scribe`` (storage, versions,
anchored comments, and the doc↔session binding are all core artifact
features), and the co-author is a stock chat slot bound to the artifact.

This package deliberately has NO backend: the store rework deleted the
prototype's docs CRUD and slot-mapping routes in favour of the core artifact
handlers. There is no ``register_routes`` re-export — dashboard/server.py's
startup loop checks ``hasattr`` and skips builtins without one.
"""
