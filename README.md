# Tonefield

A music-driven visualizer for the desktop. Each model is a physics or algorithmic system tuned to make striking visuals that move with the music: a built-in generative sequencer, a MIDI controller, or a song drives every model through its notes, its spectrum and loudness, macros and modulation. Pick a model, tweak it with sliders, and poke at it with the mouse.

![The visualizer playing along with the sequencer](docs/screenshot.png)

Built with [Tauri 2](https://tauri.app) (Rust shell, native webview) and TypeScript + Canvas 2D. macOS is the first target; Linux (`.deb`, AppImage, and a pacman package for Arch-based distros like CachyOS) and Windows 10/11 (an `.exe` installer) build from the same code.

## Models

| Model | What the music does | Interaction |
| --- | --- | --- |
| Murmuration | A flock of light streaks chases each note and takes its colour, which spreads bird to bird; kicks scatter it, snares spin vortices | Hold to attract, right-click or Shift to scatter |
| Fabric | The spectrum lifts the fabric like an equaliser; kicks blow gusts, notes pluck it and dye it. Each side (top, bottom, left, right) can be pinned on its own; Resolution (up to 200 points across) and Smoothing set how many polygons it is drawn with | Drag to pull the fabric, right-drag to slice it (it heals) |
| Living ink | Reaction–diffusion that grows where the spectrum is loud; notes seed blooms, the palette follows the melody | Drag to seed (what you draw stays fed for Brush hold seconds, so joins hold), right-drag to wipe |
| Cymatics | Glowing sand on a vibrating plate morphs to a new figure with every note; the round plate draws turning mandalas. The plate fills the screen by default, and with gravity on the sand streams through the figure endlessly | Drag to stir the sand |

Shift works in place of right-click everywhere. Most models share a **Look** group: **Afterglow** leaves fading trails, and **Tunnel zoom** and **Tunnel spin** make those trails fly outward and turn, for a feedback-tunnel effect. A **Colours** dropdown picks between following the melody, a rainbow that cycles with the beat, fire and ice.

Keyboard: `Space` play/pause the simulation, `Enter` play/stop the sequencer, `R` reset, `.` single step while paused.

The window is laid out like Photoshop: an options bar across the top (model, transport, Randomize, show or hide the music panel), the canvas as the document in the middle, and foldable panels down the right for the model, its **Parameters**, the **Global controls** that apply to every model (colour, gravity, speed, motion, size) and the model's **Macros**.

## Music

The panel under the canvas has four tabs.

- **Sequencer**: a generative band in five sections. Instead of programming steps, you steer each part and it writes and evolves the music itself.
  - **Global**: tempo, style (broken beat, four on the floor, half-time, ambient), swing, scale and root, plus synth sound, volume, **New idea** (fresh patterns and progression), **Fill** and **Hold** (freeze everything).
  - **Drums**: a euclidean sequencer drawn as three rings (kick inside, snare, hats outside). Each track's **Density** sets how many hits are spread evenly round the bar and **Variation** how much each bar strays with ghost notes, dropped hits and nudges (hits landing a hair early or late). **Steps** sets how many sixteenths the pattern has, **Offset** turns it round and **Reset** brings it back to its start every so many bars. Drag a ring round to turn its pattern; double-click to put it back. Picking a global style resets the rings to that style's beat.
  - **Bass**: a style (root pulse, off-beat, octave bounce, syncopated, walking, drone), **Density**, **Range** (root only, then octave, fifth, chord tones and passing notes) and **Variation**. It follows the chords.
  - **Chords**: jazz, pop, dance or epic, each cycling through progressions typical of the style. **Change every** sets how long each chord lasts, **Variation** switches progressions and swaps in style-typical substitutes (tritone subs, relative chords, sus and added notes), and **Rhythm density** and **Rhythm variation** shape the comping. Epic is the wildcard: cinematic progressions with chromatic jumps and power chords, doubled an octave each side, and now and then it lifts the whole song up a step for a pass.
  - **Melody**: a style (wander, arpeggio, motif, lyrical), **Range**, **Density**, and **Groove**, which adds syncopation, clips notes shorter and makes the second half of the bar answer the first. Strong beats lean on chord tones.
  Every part has a switch to mute it, and every control can be mapped to a MIDI knob. It plays through a small built-in synth (or silently, with Sound off) and sends every hit, bass note and chord to the current model.
- **Modulation**: routes that let a music source push a slider. Sources are note envelopes (any note, kick, snare, hat, melody), last velocity and pitch, held MIDI notes, tempo-synced LFOs, audio levels (overall, bass, mids, treble), the mod wheel, pitch bend and any MIDI CC. Targets are the model's number sliders and its macros. A coloured bar under a slider shows how far it's being pushed.
- **MIDI**: pick input devices, play notes through the synth, and map knobs with MIDI learn (click MIDI learn, click a slider or macro, turn a knob). Macro and sequencer mappings carry across models, so a knob can ride a drum track's density or the chord speed live.
- **Audio file**: play a song; its levels become modulation sources and its kick drums trigger note reactions.

Every model also reacts to the music by itself: to each kind of note, and continuously to the sound's bass, loudness, spectrum and waveform. The Modulation tab lists each of these **built-in reactions** with a live meter and a switch to turn it off. The **Intensity** slider there scales them along with every route, and **Music drives the visuals** turns them all off. Each model also has a few **macros**: single 0..1 knobs that push several parameters at once. Routes, macro settings and switched-off reactions are saved per model.

MIDI goes through the Rust side ([`src-tauri/src/midi.rs`](src-tauri/src/midi.rs), using `midir`) because the Linux and macOS webviews don't support Web MIDI (on Windows it uses the same path, through the system's WinMM MIDI). Messages reach the UI as `midi-message` events. On Linux that needs ALSA (`alsa-lib` on Arch, `libasound2-dev` to build on Debian/Ubuntu). In a plain browser (`npm run dev`) the app falls back to Web MIDI where the browser has it.

## Running it

Prerequisites: Node 20+, Rust (stable, via [rustup](https://rustup.rs)), and the [Tauri system dependencies](https://tauri.app/start/prerequisites/) for your OS (on macOS that's just Xcode Command Line Tools: `xcode-select --install`).

```sh
npm install
npm run tauri dev     # desktop app with hot reload
npm run dev           # or just the UI in a browser at http://localhost:1420
```

Build a distributable:

```sh
npm run tauri build   # macOS: .app + .dmg   Linux: .deb + .AppImage   Windows: setup .exe
```

On Linux, install the webview deps first:

```sh
# Debian / Ubuntu
sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libasound2-dev

# Arch / CachyOS / EndeavourOS / Manjaro
sudo pacman -S --needed base-devel webkit2gtk-4.1 librsvg alsa-lib rust nodejs npm
```

## Installing on Arch-based distros (CachyOS, EndeavourOS, Manjaro)

### Build a pacman package (recommended)

The repo ships a [`PKGBUILD`](packaging/arch/PKGBUILD) that builds the app from your checkout and installs it like any other package, with a launcher entry and icon.

```sh
sudo pacman -S --needed base-devel git
git clone https://github.com/thomas-nelson23/tonefield.git
cd tonefield/packaging/arch
makepkg -si
```

`makepkg -s` pulls in everything it needs (Rust, Node, `webkit2gtk-4.1`). If you already use `rustup`, that works too. Then launch **Tonefield** from your app menu, or run `tonefield`.

- Update: `git pull`, then `makepkg -sif` in `packaging/arch`.
- Uninstall: `sudo pacman -R tonefield`.

The repo is private, so `git clone` needs you signed in to GitHub (for example `gh auth login`, or clone over SSH).

### Download a prebuilt package

Every push to `main` builds an Arch package in CI.

1. Open the repo's **Actions** tab, pick the latest **Build** run on `main`, and download the `tonefield-arch` artifact.
2. Unzip it and install:

   ```sh
   sudo pacman -U tonefield-*.pkg.tar.zst
   ```

### AppImage (no install)

The `tonefield-Linux` artifact from the same run contains an AppImage that runs without installing anything. It needs FUSE 2:

```sh
sudo pacman -S --needed fuse2
chmod +x Physics*.AppImage
./Physics*.AppImage
```

The AppImage is built on Ubuntu and bundles its own libraries, so the pacman package is the better fit on Arch.

### Troubleshooting

- **Blank or white window, or a crash on start (common with NVIDIA drivers):** the app now sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` itself on Linux, so this should not happen. If you need the DMA-BUF renderer back, launch with `WEBKIT_DISABLE_DMABUF_RENDERER=0 tonefield`.

## Installing on Windows 10/11

Every push to `main` builds a Windows installer in CI.

1. Open the repo's **Actions** tab, pick the latest **Build** run on `main`, and download the `tonefield-Windows` artifact.
2. Unzip it and run `nsis/Tonefield_<version>_x64-setup.exe`. It installs for your user only, so it needs no admin rights, and adds Start menu and uninstall entries.

The installer isn't code-signed, so Windows SmartScreen says "Windows protected your PC" the first time: click **More info**, then **Run anyway**. The app runs on Microsoft Edge WebView2, which Windows 11 and up-to-date Windows 10 already have; if it's missing, the installer downloads it.

To build it yourself on Windows, install Node, Rust (via rustup, with the MSVC toolchain) and the Visual Studio C++ Build Tools ([Tauri's Windows prerequisites](https://tauri.app/start/prerequisites/#windows)), then run `npm install` and `npm run tauri build -- --bundles nsis`. The installer lands in `src-tauri/target/release/bundle/nsis/`.

## Adding a model

Every model implements `SimulationModel` from [`src/models/types.ts`](src/models/types.ts). The host app owns the canvas, the fixed-timestep loop, the parameter sliders and pointer routing, so a model only describes its parameters and implements `reset`, `step` and `render` (plus optional `onPointer`, `onNote`, `resize` and `stats`).

1. Create `src/models/myModel.ts` exporting a `ModelDefinition`:

   ```ts
   import type { ModelDefinition, SimulationModel } from "./types";

   class MyModel implements SimulationModel {
     reset(view, params) { /* build state */ }
     step(dt, params, music) { /* advance state by dt seconds */ }
     render(g, view, params, music) { /* draw with the 2D context */ }
   }

   export const myModel: ModelDefinition = {
     id: "my-model",
     name: "My model",
     category: "Custom",
     description: "What it shows.",
     params: [
       { kind: "number", key: "strength", label: "Strength", min: 0, max: 10, step: 0.1, default: 1 },
     ],
     create: () => new MyModel(),
   };
   ```

2. Add it to the list in [`src/models/registry.ts`](src/models/registry.ts).

Sliders, checkboxes and dropdowns (`kind: "choice"`) are generated from `params` automatically. Mark a param `resetOnChange: true` if changing it should rebuild the simulation (e.g. a particle count).

To make a model musical:

- Read the `MusicFrame` passed to `step` and `render`: drum and melody envelopes (`kick`, `snare`, `hat`, `tone`), audio bands (`level`, `bass`, `mid`, `treble`), a 48-bin log `spectrum`, a `wave` snapshot, the beat clock (`beats`, `pulse`), the last note's `hue` and `pitch`, and an overall `energy`. Values are already scaled by Intensity and zeroed for reactions the user switched off.
- List what the model does with the music in `reactions` (`{ source: "bass", text: "The ring swells" }`), so it shows in the Modulation tab with a switch.
- Set `paintsBackground: true` to draw your own background, e.g. with `Feedback` from `models/lib/visual.ts` for trails and the tunnel effect.
- Implement `onNote(note, params)`. A `NoteEvent` has the MIDI `note`, `velocity` (0..1), a `role` (`"kick"`, `"snare"`, `"hat"` or `"tone"`) and `x`, the note's place in its range from 0 (lowest) to 1 (highest), handy as a left-to-right position. `noteHue` in `models/lib/music.ts` gives a consistent colour per pitch.
- Add `macros`: each is a 0..1 knob with `targets: [{ param, amount }]`, where `amount` is a fraction of that param's range.
- Add default `modulations`, e.g. `{ source: "kick", target: "strength", amount: 0.2 }`, so music does something before anyone opens the Modulation tab.

Number params without `resetOnChange` can be modulated; the model always receives the modulated values in `params`.

## Project layout

```
src/
  main.ts            app shell: canvas, loop, input, model switching
  models/
    types.ts         the model interface
    registry.ts      list of available models
    cloth.ts         Fabric: Verlet cloth lifted by the spectrum
    boids.ts         Murmuration: flocking light streaks
    reaction.ts      Living ink: Gray-Scott reaction-diffusion
    chladni.ts       Cymatics: sand figures on a vibrating plate
    lib/visual.ts    trails / tunnel feedback, glow sprites, colour schemes
    lib/raster.ts    pixel buffer + palettes for grid models
    lib/music.ts     note colours and helpers for musical models
  music/
    studio.ts        music panel: sequencer UI, routes, MIDI learn, audio file
    sequencer.ts     generative drums, bass, chords and melody with lookahead scheduling
    audio.ts         drum kit, synth, file player, band and spectrum analyser
    modulation.ts    modulation sources and how they combine with sliders and macros
    midi.ts          MIDI input (Tauri events, or Web MIDI in a browser)
  ui/controls.ts     builds parameter controls from a model's spec
src-tauri/           Rust/Tauri desktop shell, bundle config and MIDI input
```
