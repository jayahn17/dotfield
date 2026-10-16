# Recipe — see a room in VR on a Quest, and record the evidence

A render is `provisional` until someone has looked at it: every render receipt says `evidence.browser: not_captured` and the skill report says **provisional**. This recipe puts a scene on a Meta Quest over USB, with no cloud, no app store and no network path, and records the screenshot in the receipt with `scripts/evidence.mjs`. It is opt-in and never runs in CI (`VISION.md` §10, §13); the VR row of `references/MATURITY.md` moves up only with a capture made this way.

## What you need

- A Quest 2, 3 or Pro with developer mode on, a USB-C cable, and `adb` (Android platform-tools) on the laptop. `adb devices` must list the headset as `device`, not `unauthorized` (accept the USB-debugging prompt inside the headset once).
- The vendored three.js: `node scripts/fetch-vendor.mjs` (fetches by pinned hash; `node scripts/fetch-vendor.mjs --verify` must exit 0). Without it a 3D/VR render is blocked with `DF_RENDER_VENDOR_MISSING`.
- A center with a session key: `node bin/dotfield.mjs init --pack <id>` (or any center you already serve).

## 1. Render with the VR view

```
node bin/dotfield.mjs render room:experiments/graph --view all --json
```

Read `outputs[0].ref` in the receipt: `.dotfield/renders/<kind>-<slug>-<ts>/out.html`. The folder also holds `scene.json`, `out.svg` and `receipt.json`. A render for another person (`--for <person_id>`) embeds three.js as data: URLs; a render for yourself may reference the vendored files through the importmap, which `serve` also answers. Both open on the headset the same way.

## 2. Serve, and make the laptop reachable from the headset as 127.0.0.1

```
node bin/dotfield.mjs serve          # 127.0.0.1:4100, same-origin, no CORS
adb reverse tcp:4100 tcp:4100        # on the headset, 127.0.0.1:4100 is now this server
```

Two things are load-bearing here. `127.0.0.1` on the headset is a secure context, so the Quest browser allows WebXR; a LAN address would not (the VR tab would show the honest overlay `insecure`). And `server/wall.mjs` treats the request as local (a loopback peer with no `X-Forwarded-For` and a loopback `Host` — the headset's address bar says `127.0.0.1:4100`), so the owner-only `/renders/<id>/<file>` route answers. Nothing is opened to the LAN; unplug the cable and the path is gone.

## 3. Open it in the headset

Type `http://127.0.0.1:4100/renders/<id>/out.html#view=vr` in the Quest browser, or let the laptop do it:

```
adb shell am start -a android.intent.action.VIEW -d "http://127.0.0.1:4100/renders/<id>/out.html#view=vr"
```

The page opens on the VR tab. The button reads **Enter VR** when the session machine is `ready`; put the headset on and press it. Floor, teleport (point at the floor, trigger) and node select (point at a node, trigger) come from `renderers/xr.mjs`; the label budget is `views.vr.label_budget`. Squeeze grabs the whole scene.

## 4. Capture, and write it into the receipt

From the laptop, while the scene is on the headset:

```
node scripts/evidence.mjs .dotfield/renders/<id> --device adb --wait 20
```

`--wait` gives you the seconds to enter VR after pressing Return; `--open` opens the URL from step 3 for you first; `--serial <S>` picks a headset when several are attached; `--port` follows `serve` when it is not 4100. The script runs `adb reverse`, reads the device model, pulls `adb exec-out screencap -p` into `.dotfield/renders/<id>/evidence-adb-<model>.png`, and rewrites `receipt.json` (and its copy under `.dotfield/receipts/`) with

```
"evidence": { "browser": "captured", "screenshot_ref": ".dotfield/renders/<id>/evidence-adb-quest-3.png", "device": "adb:Quest 3" }
```

plus the PNG as an output with its sha256 and a new `next_action`. The body digest is recomputed, so `node bin/dotfield.mjs verify .dotfield/renders/<id>/receipt.json` still passes; move or delete the PNG and verify reports `DF_RECEIPT_REF_MISSING`, which is the point.

## 2D and 3D in a desktop browser (no headset)

Open `out.html` in any browser (or in the Claude Code browser pane during a session), take a screenshot, save it as a PNG, then:

```
node scripts/evidence.mjs .dotfield/renders/<id> --screenshot ~/Desktop/experiments-3d.png
```

That records `device: "browser"` and the same receipt fields. The desktop VR tab shows the overlay text `unsupported` (no immersive-vr session) — that is honest, not a bug; the 2D and 3D views are complete without it.

## When it does not work

| You see | It means | Do |
|---|---|---|
| `adb reverse tcp:4100 failed: no devices/emulators found` | the headset is not attached or not authorised | `adb devices`; accept the prompt in the headset; try another cable or port |
| the VR tab says `insecure` | the page was reached by a LAN IP or hostname, not 127.0.0.1 | use `adb reverse` and the 127.0.0.1 URL |
| the VR tab says `unsupported` | the browser has no `immersive-vr` (desktop Chrome, Safari) | expected off-headset; capture 2D/3D with `--screenshot` instead |
| the VR tab says `blocked` | a permissions policy or an embedding frame denies WebXR | open the page top-level, not inside another page |
| `DF_RENDER_VENDOR_MISSING` at render | `vendor/three/` not fetched or tampered | `node scripts/fetch-vendor.mjs`, then `--verify` |
| `screencap -p gave no PNG` | the device returned text (locked screen, old adb) | unlock the headset, update platform-tools, retry |
| `receipt command is 'validate', not render` | you pointed `evidence.mjs` at the wrong receipt | pass the `.dotfield/renders/<id>/` folder |

The capture is a picture of your own private render on your own headset; nothing leaves the laptop. Keep the PNG beside the receipt — `delete` sweeps the render folder with everything else when the records it shows are deleted.
