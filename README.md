# URL Clip Source

A workflow-integration panel that turns a web-video link into a trimmed, edit-ready clip you can drag onto the host editor's timeline.

## What it does

- Loads a supported video page in a dedicated preview panel.
- Gives you source-style In and Out points, frame stepping and timecode.
- Downloads only the selected range, at up to 720p, 1080p, 1440p or 2160p.
- Produces a normal MP4 that the host editor can import and edit.
- Lets you drag the prepared clip from the panel onto the Edit timeline.
- Also offers **Insert at playhead**, **Add to Media Pool**, and cache management.
- Keeps a library of prepared clips so you can reuse a range without downloading it again.

## Requirements

| Requirement | Details |
|---|---|
| Host | The paid edition of the host editor, version 19 or newer, with Workflow Integrations enabled |
| OS | 64-bit desktop system supported by the packaged media tools |
| Internet | Needed to read video metadata and download clips |
| Disk | About 130 MB for the downloaded tools plus space for cached clips |

Workflow Integrations are available only in the paid edition. Store-distributed builds with sandbox restrictions may not expose the menu.

## Install

1. Quit the host editor.
2. From this folder, run the installer:

   ```powershell
   .\install.ps1
   ```

3. Start the host editor and open a project.
4. Choose **Workspace > Workflow Integrations > URL Clip Source**.

The installer downloads the video downloader and media helper on first install. The host bridge module is copied from the installed host developer package.

To remove it:

```powershell
.\uninstall.ps1
```

Add `-DeleteCache` to remove downloaded clips as well.

## Use

1. Paste a video page link or an 11-character video ID into the top bar and press **Load video**.
2. Play or scrub the preview.
3. Set **In** and **Out**:
   - Press `I` and `O`.
   - Or click **Set In** / **Set Out**.
   - Or drag the green and amber range handles.
4. Choose the download height in Settings if needed (1080p by default).
5. Click **Prepare clip**. Only the selected range is downloaded.
6. Do one of the following:
   - Drag the card in **Prepared clips** onto the Edit timeline.
   - Click **Insert at playhead** to place it on the selected video track at the timeline playhead.
   - Click **Add to Media Pool** to put it in the configured bin and select it.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `I` / `O` | Set In / Out at the playhead |
| `Shift+I` / `Shift+O` | Go to In / Out |
| `Space` | Play / pause |
| `←` / `→` | Step one frame |
| `Shift+←` / `Shift+→` | Step one second |
| `J` / `K` / `L` | Back 5s / pause / play |
| `Home` / `End` | Go to start / end |

## The Source Viewer question

The host's published scripting API does **not** expose a way to:

- load a URL into the host's own Source Viewer, or
- inject a drag from a third-party window into the Edit timeline.

There is no supported API, menu command or hidden method for either. A plugin can add a media file to the Media Pool and select it, but it cannot programmatically open that item in the Source Viewer.

URL Clip Source therefore reproduces the source-viewer workflow inside the panel:

- The panel's player is the source viewer.
- In/Out, frame stepping, timecode and range handles behave like a source viewer.
- The prepared clip is a normal media file. Dragging it from the panel starts a native file drag, which the host accepts on the Edit timeline.
- If you specifically want the clip in the host's own Source Viewer, use **Add to Media Pool**, then double-click the selected clip in the configured bin (or press `Enter` while the Media Pool is focused).

This is a platform limitation, not a setting.

## Settings

| Setting | Purpose |
|---|---|
| Maximum download height | 720p, 1080p, 1440p or 2160p. Higher means larger files and slower downloads. |
| Media Pool bin | The bin used by **Add to Media Pool** and **Insert at playhead**. Default: `Web Clips`. |
| Target video track | V1–V8 for **Insert at playhead**. |
| Cache | Shows the cache size. You can open or clear the folder. |

Downloads live in:

```text
%LOCALAPPDATA%\URL Clip Source\clips
```

The log is at:

```text
%LOCALAPPDATA%\URL Clip Source\app.log
```

## Troubleshooting

### Workspace > Workflow Integrations is missing

The menu is part of the paid edition and is not present in the free build or in store-distributed builds that restrict workflow integrations.

Open the host's About dialog. If it does not identify the paid edition, install the paid build, activate the license, and restart.

### The plugin is listed but does not open

- Make sure the host bridge module exists in the plugin folder. The installer refreshes it from the installed SDK.
- Check `%LOCALAPPDATA%\URL Clip Source\app.log`.
- Restart the host editor fully. The plugin list is built at startup.

### Loading a video fails

- Update the downloader from Settings.
- Try a different video; the owner may have disabled embedding or the video may be region-restricted.
- Private, member-only and age-restricted videos are not supported by this build.

### The preview says "Preview blocked by the source site"

The video owner disabled embedded playback. You can still use the panel's range controls, but there is no picture to preview. Open the source page to choose times, then set the handles.

### Dragging does nothing

The drag source is a native file. Drop it on the timeline area, not on the panel. If the host window is running elevated or on a different desktop, the OS may block the drop; use **Insert at playhead** instead.

### Insert at playhead fails

- Open a timeline on the Edit page first.
- Set a target video track in Settings.
- If the host reports that it cannot place the clip, use **Add to Media Pool** and place it manually.

### The clip is slightly off from the requested time

URL Clip Source asks the downloader to force keyframes at the cut points and verifies that a playable MP4 was produced. Some source streams still round to the nearest keyframe. Set a slightly wider range and trim in the host editor if you need frame-exact edges.

## Development

The plugin is plain HTML/CSS/JS with no build step:

```text
com.gustaf.urlclipsource/
  manifest.xml          host plugin manifest
  package.json          entry point
  main.js               main process + host API bridge
  preload.js            contextBridge IPC surface
  index.html            panel markup
  css/styles.css        panel styling
  js/renderer.js        player, range UI, library, settings
  bin/                  tools downloaded by the installer
  WorkflowIntegration.node  copied from the host developer package
```

Run `install.ps1` after changes, then restart the host.

## Legal

Only download content you own or have permission to use. Downloading from a source platform may violate that platform's terms of service. This project is not affiliated with or endorsed by any source platform or host application vendor.

## Third-party software

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Third-party component names remain there because their licenses require attribution.
