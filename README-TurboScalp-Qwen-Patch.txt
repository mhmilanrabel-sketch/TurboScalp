TurboScalp Local Qwen Integration Patch

Files:
- TurboScalp-Local-Qwen-Integration.mjs

How to use on Windows:
1. Download and extract the ZIP to any temporary folder.
2. Copy TurboScalp-Local-Qwen-Integration.mjs into:
   C:\Users\milan\TurboScalp-Git-Clean
3. Open PowerShell and run:
   cd C:\Users\milan\TurboScalp-Git-Clean
   node .\TurboScalp-Local-Qwen-Integration.mjs

The script expects the current Git branch to be:
fix/demo-position-reconciliation

It verifies all source-file patch anchors before writing changes and creates timestamped backups first. It does not alter trade journals, Binance credentials, server/autonomousDemoBot.ts, or existing safety patch files.

After successful application, run:
   npm.cmd run lint
   node --import tsx --test .\server\ollamaRoutes.test.ts .\server\agent\agent.test.ts
   npm.cmd run build
   git -c core.whitespace=cr-at-eol diff --check

Do not enable automated trading during development and validation.
