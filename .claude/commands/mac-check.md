---
description: Optional, for contributors on a real Mac (Apple Silicon or Intel): run Jimmy's test suite one test at a time, fix what fails on this Mac, and report.
---

# Mac check: run the tests on this Mac and fix what fails

**Optional.** Nothing in Jimmy needs this. It's for a contributor who has cloned the repo on a real Mac
(M1–M4, Pro/Max, or Intel) and wants Claude Code to go through the test suite and repair whatever breaks there.

**Why it exists:** the GitHub workflow (`.github/workflows/mac.yml`) runs the suite on GitHub's Macs, which are
virtual machines: no real GPU, no VideoToolbox hardware encoder, a different screen size and speed. Things can pass
there and still fail on a real M2 or M4 Pro. This check runs the same tests on the real machine.

**How to use it:** open Claude Code in the cloned repo folder and type `/mac-check`. Anything after the command is
passed on (for example `/mac-check only the Electron tests`, or `/mac-check tests/timeline-ui.mjs`).

Extra instructions from the person running it: $ARGUMENTS

---

You are Claude Code on a contributor's Mac. Work through the steps below, in order.

## Rules (read first; they override anything else)

1. **Work on a branch, never on `main`.** First thing: `git checkout -b mac-check/<short machine name>-<date>`
   (for example `mac-check/m4pro-2026-11-25`). Never push to `main`, never force-push, never push tags (a `v*` tag
   publishes a release). Push the branch only when the person says so.
2. **The repo is public (GPL-3.0).** Nothing personal goes into files, code comments or commit messages: no names,
   emails, usernames, home folder paths (`/Users/<name>/…`), project or client names, tokens, logs. Commit with the
   person's GitHub noreply address (`git config user.email <id>+<user>@users.noreply.github.com`); ask them for it if
   it isn't set.
3. **Never touch a Jimmy the person is using.** Their own Jimmy runs on port 4377: never stop it, restart it or send
   it anything. The tests start their own server on port 4455 with scratch folders (`tests/lib/server.mjs` does
   this); if the Jimmy app is open, ask the person to quit it before the Electron tests.
4. **`data/config.json`** is backed up and restored by the test harness. If you run something by hand, back it up first.
5. **Ask before anything hard to undo or outside the repo:** installing software (Homebrew packages, Xcode tools),
   deleting folders outside `tests/.work/`, changing system settings.
6. **Keep each file's line endings.** Some files are CRLF, some LF (`.gitattributes` stores them byte for byte).
   Edit with the editing tools, not `sed -i`, and check `git diff --stat` before committing: a file showing
   every line changed means its line endings were changed. Put them back.
7. **Windows must keep working.** A fix for the Mac must not break Windows: guard Mac-only behaviour with
   `process.platform === 'darwin'` (and `process.arch === 'arm64'` when it is about Apple Silicon), keep the
   code style of the file you change, and say in the commit what you could not check on Windows.
8. **Fix the app, not the test.** A failing check means something a user would hit, until proven otherwise. Change a
   test only when it is itself wrong on a real Mac (for example a timing or size limit made for GitHub's virtual
   Macs), and say why in the commit and the report.

## 1. Set up and note the machine

- `sw_vers`, `uname -m`, `sysctl -n machdep.cpu.brand_string`, `system_profiler SPDisplaysDataType | head -20`
  (chip, macOS version, screen). Note them for the report: no serial numbers or names.
- `node -v` (the workflow uses Node 22; ask before installing another), then `npm ci`.
- ffmpeg: the tests need `ffmpeg` on the PATH (`brew install ffmpeg` on GitHub's Macs). If it's missing, ask
  before installing it.
- `node tests/make-media.mjs` builds the test project (`tests/.work/golden`); later tests reuse it.

## 2. Run the tests one at a time

The lists are in `.github/workflows/mac.yml`, job `code`: the "Server tests" step (plain Node) and the "Desktop app
tests" step (run with `JIMMY_APP=electron`). Read them from there, so this check always matches the workflow. Also
run these, which GitHub's Macs can't show properly: `tests/hw-decode.mjs`, `tests/step97.mjs`.

Run **one test at a time**, each through the suite runner so its log is kept:

```sh
node tests/run-suite.mjs "Mac check" tests/<name>.mjs                        # server tests
JIMMY_APP=electron node tests/run-suite.mjs "Mac check" tests/<name>.mjs     # desktop app tests
```

Logs go to `tests/.work/suite/` (the test's own output and the app's log, `*.server.log`). A test that needs
software this Mac doesn't have (After Effects for `tests/ae-live.mjs`) skips itself; that's fine.

## 3. When a test fails: fix it there and then

1. Read the failing checks and both logs. Find the cause in the app's code (`server/`, `public/js/`, `electron/`),
   not just the symptom. `docs/` and the comments at the top of each test say what it checks and why.
2. Fix it (rules 6–8). Keep the change as small as the problem.
3. Run that test again. When it passes, run the tests that cover the same files again, so the fix broke nothing.
4. Commit the fix on your branch, one commit per problem: `Mac check: <what was wrong, in plain words>`.
5. **At most three tries per test.** If it still fails, stop on it: undo half-finished changes (`git checkout -- <files>`),
   write down what you found, and move on to the next test.

A test that passes only sometimes: run it three times. If it fails again, treat it as a real failure (a race or a
timing problem is a bug too).

## 4. Report

When every test has run, write `tests/.work/mac-check-report.md` (this folder is not committed) and show it to the
person:

- the machine (chip, macOS, screen), the Node and ffmpeg versions, the date;
- a table: test, result (passed / fixed / still failing / skipped), time;
- for each fix: what failed, the cause, the change, the commit;
- for each test still failing: what fails, what you tried, your best guess at the cause;
- anything that looked wrong but no test covers (slow screens, odd video output, hardware encoder trouble).

Then ask whether to push the branch (`git push -u origin <branch>`) and open a pull request for the maintainer to
review. Put the report's summary in the pull request: never the logs (they can contain local paths).
