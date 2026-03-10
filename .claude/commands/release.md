---
description: Tag a release and push to trigger GitHub Actions NPM publish
argument-hint: [patch|minor|major] (optional - auto-detected if omitted)
allowed-tools:
  - Bash(npm test:*)
  - Bash(npm pack:*)
  - Bash(git status:*)
  - Bash(git add:*)
  - Bash(git commit:*)
  - Bash(git tag:*)
  - Bash(git push:*)
  - Bash(git branch:*)
  - Bash(git log:*)
  - Bash(git describe:*)
  - Bash(git diff:*)
  - Bash(node:*)
  - Read
  - Edit
  - Write
---

# Release @gpriday/create-image-mcp

NPM publishing is handled by GitHub Actions on tag push. This command bumps the version, tags, and pushes.

## Current State
- Git status: !`git status`
- Current branch: !`git branch --show-current`
- Latest tag: !`git describe --tags --abbrev=0 2>/dev/null || echo "none"`
- Current version: !`node -p "require('./package.json').version"`
- Changes since last tag: !`git log $(git describe --tags --abbrev=0 2>/dev/null || echo "HEAD")..HEAD --oneline 2>/dev/null || echo "No previous tags"`

## Steps

### Step 1: Analyze Changes & Determine Version

Version bump override: $ARGUMENTS

**If $ARGUMENTS is empty, auto-detect version bump:**

Read all commits since the last git tag. Analyze commit messages following Conventional Commits:
- **MAJOR** (breaking): Look for "BREAKING CHANGE:", "!" after type (e.g., "feat!:"), or "major:" prefix
- **MINOR** (feature): Look for "feat:", "feature:", new functionality
- **PATCH** (fix): Look for "fix:", "bugfix:", "chore:", "docs:", "refactor:", "test:", "style:", improvements

Rules:
- If any BREAKING CHANGE found → MAJOR bump
- If any feat/feature found (no breaking) → MINOR bump
- Otherwise → PATCH bump
- If no commits since last tag → Ask user if they want to proceed with PATCH

Calculate new version based on current package.json version and bump type.

### Step 2: Pre-Release Validation

1. **Check for Uncommitted Changes**
   - Run `git status --porcelain`
   - If ANY uncommitted changes exist: STOP and tell user to commit or stash first

2. **Verify Prerequisites**
   - Must be on `main` branch (STOP if not)
   - Run `npm test` - all tests must pass (STOP if any fail)

### Step 3: Update package.json

- Read current package.json
- Update `version` field to new calculated version
- Write back to file

### Step 4: Commit & Tag

```bash
git add package.json
git commit -m "chore: prepare for v[NEW_VERSION] release"
git tag -a v[NEW_VERSION] -m "Release version [NEW_VERSION]

[First 3-5 key changes from commit history]"
```

### Step 5: Push (triggers GitHub Actions publish)

```bash
git push origin main
git push origin v[NEW_VERSION]
```

### Step 6: Report

**Report to user:**
- Version tagged: v[NEW_VERSION]
- GitHub Actions will publish to NPM automatically
- NPM: https://www.npmjs.com/package/@gpriday/create-image-mcp
- **Key changes in this release:**
  [List 3-5 main changes from commit history since last tag]

## Error Handling

**If tests fail:**
- Report which tests failed
- STOP release process

**If git has uncommitted changes:**
- STOP and tell user to commit or stash first

**If git push fails:**
- Check remote access and branch status
- Tag and commit are local only until push succeeds — safe to retry
