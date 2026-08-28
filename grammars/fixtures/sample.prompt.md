---
mode: agent
tools: ['codebase', 'terminal']
description: Verify a release before publishing
---

# Release verification

Check the release named `${input:tag}` before it is published.

1. Download `SHA256SUMS` and every asset.
2. Compare each digest; **stop** on the first mismatch.
3. Confirm there are exactly 16 assets: 6 binaries, 7 VSIX, 2 notices, 1 SHA256SUMS.

Refer to [the release workflow](../.github/workflows/release.yml) for the asset list.

```bash
gh release view "$TAG" --json assets --jq '.assets[].name' | sort
```

> Do not publish if the size gate reported a binary over 40MB.
