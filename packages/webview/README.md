# @agentflow/webview

The multi-run dashboard, inbox and run-detail React app (§10.1, §10.4). **Lands
in M3**, alongside the concurrency governor and live-changes diff.

M0 deliberately ships the run-detail timeline as plain HTML inside the
extension host ([runDetailPanel.ts](../extension/src/views/runDetailPanel.ts)).
It renders from the same event stream this package will consume, so moving it
here is a port, not a rewrite — and it keeps a React/Vite build off the
critical path until there is a dashboard worth building.
