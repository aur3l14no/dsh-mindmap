# Installing DSH Mindmap (for agents)

You are installing [DSH Mindmap](https://github.com/aur3l14no/dsh-mindmap), a
plugin bundle for DSH, into the user's DSH profile. It changes every session
of that profile, so tell the user what you will run before running it.

## 1. Find the DSH and the profile

- In a terminal, `dsh --version` must print `0.2.x` (the bundle accepts
  `>=0.2.1-rc.2 <0.3.0`). Older or newer: stop and tell the user.
- The usual target is the `web` profile, the one `dsh web` starts. If the user
  runs the DSH Desktop app, its profile cannot be changed from the `dsh`
  command: use the `plugin_manager` tool inside DSH, or have the user follow the
  Plugins-page steps in the README.

## 2. Pick the package

Open https://github.com/aur3l14no/dsh-mindmap/releases/latest and take the
download address of its `dsh-mindmap-<version>.tgz` asset. Use that versioned
address, not a `/latest/` link: the profile's lockfile pins the file's checksum.

## 3. Install

From a terminal, with `<url>` from step 2 (skip the first line if the profile
already lists `@deepseek-ai/dsh-experimental-agent-team-profile`):

```sh
dsh plugin --profile web add @deepseek-ai/dsh-experimental-agent-team-profile@$(dsh --version)
dsh plugin --profile web add <url>
```

`dsh plugin add` installs the package and turns its bundle on.

Inside DSH, with the `plugin_manager` tool (Creator mode; each call asks the
user for approval): `list_bundles`; if
`@deepseek-ai/dsh-experimental-agent-team-profile` is off, turn it on with
`set_bundle` (or `install_bundle` when it is not installed); then
`install_bundle` with `<url>` as the spec.

## 4. Apply and check

- A running DSH whose profile does not reload live needs a restart (`dsh web`
  for the Web profile); `plugin_manager` results say when a restart is
  required.
- Check: `@local/dsh-mindmap` and the Agent Teams bundle appear among the
  profile's bundles without an error (Plugins page, `list_bundles`, or
  `dsh.profile.bundles` in the profile's `package.json`), and
  **Mindmap** appears in the Web sidebar.

## 5. Tell the user how to start

Open **Mindmap** in the sidebar, pick a workspace and create a canvas. Press
**F**, drag a box, type what it should hold and press Enter: an agent takes the
box. Talk to the lead in the chat under the canvas.

## Do not

- Grant a version exemption (`allow-version`, `set_version_exemption`) unless
  the user explicitly accepts the risk for that exact version pair.
- Edit the profile's `cordis.patch.yml` or other plugins to make the install
  succeed. Report the error to the user instead.
