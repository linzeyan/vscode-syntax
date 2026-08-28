=================
poly-syntax 說明
=================

.. contents:: 目錄
   :depth: 2

Overview
========

``poly-syntax`` ships every grammar VSCode contributes, pinned by SHA.

* Grammars come from ``grammars/sources.json``.
* The lock file records upstream SHAs and per-file digests.
* CI re-runs the sync and fails on drift.

Verifying
---------

Run the tokenize gate::

    node tools/tokenize-check.mjs /tmp/tokdeps/node_modules

.. note::

   The gate requires every fixture to reach 30% scoped tokens.

.. code-block:: python

   def budget_ok(samples, limit=200):
       return sorted(samples)[int(0.95 * len(samples))] <= limit

See `the roadmap <docs/03-roadmap.md>`_ for the batch plan.

.. _upstream: https://github.com/microsoft/vscode
