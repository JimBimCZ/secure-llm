# Monitor and display notes

The component you look at continuously and the one most often bought last with whatever
budget survived.

## Panel technologies

**IPS** — accurate colour, wide viewing angles, the safe default. Weakness is contrast:
blacks are grey in a dark room, and "IPS glow" in the corners is a characteristic of the
technology, not a defect worth returning a panel over.

**VA** — much better contrast, genuinely black blacks. Weakness is response time on dark
transitions, which shows up as smearing behind moving objects on dark scenes. Improved a
lot, still present.

**OLED** — per-pixel light, so contrast is effectively infinite, and response times an order
of magnitude faster than either of the above. Two real costs: burn-in risk from static
elements (taskbar, HUD, an IDE's sidebar — exactly what a desktop displays all day), and
lower full-screen brightness than the peak-brightness marketing figure suggests, because
that peak applies to a small window of the screen.

I run IPS on the desk. The static-content argument is decisive for a machine that shows the
same editor layout eight hours a day. OLED for a machine used mainly for video and games is
a different and defensible answer.

## Refresh rate and frame pacing

The step from 60 Hz to 120–144 Hz is large and immediately obvious in ordinary use — cursor
movement and window dragging, not only games. Above roughly 144 Hz the returns diminish
sharply for anything that isn't competitive shooting.

**Consistency matters more than the number.** A steady 90 fps feels better than one
oscillating between 110 and 140. This is what variable refresh rate (Adaptive-Sync, marketed
as FreeSync or G-Sync) exists to fix: the display refreshes when the frame is ready instead
of on a fixed clock, which removes both tearing and the stutter of a missed refresh. Turn it
on; there is no downside within the supported range.

Note the **supported range** — a monitor with a 48–144 Hz VRR window behaves badly below 48
fps unless it supports low framerate compensation, which duplicates frames to stay in range.
Check for LFC on any panel where you expect to drop below 48.

## Resolution and scaling

- **1440p at 27"** — roughly 109 PPI. Sharp enough without scaling. The best value point,
  and what I use.
- **4K at 27"** — roughly 163 PPI. Genuinely sharper, but needs display scaling at around
  150%, and scaling remains imperfect on Windows for older applications. On macOS it is a
  solved problem; on Windows it is a mostly-solved problem with irritating exceptions.
- **4K at 32"** — roughly 138 PPI. The sweet spot if the desk is deep enough, usable at 100%
  scaling by people with good eyesight.
- **Ultrawide 3440×1440** — excellent for side-by-side work, and a meaningful fraction of
  games and most video will letterbox.

Pixel density drives graphics load quadratically: 4K is 2.25× the pixels of 1440p. A card
that is comfortable at 1440p is not comfortable at 4K, and this interacts with everything in
my GPU note about VRAM.

## Cables and bandwidth — where it actually goes wrong

The failure mode is silent: the display negotiates something lower and simply doesn't tell
you. Symptoms are a refresh rate capped below the panel's rating, VRR unavailable, or 8-bit
colour where 10-bit was expected.

- **DisplayPort 1.4** — 32.4 Gbit/s raw (25.92 Gbit/s of payload). 4K at 144 Hz needs DSC
  compression to fit.
- **DisplayPort 2.1** — UHBR13.5 and UHBR20 tiers, up to 80 Gbit/s. Enough for 4K at high
  refresh uncompressed.
- **HDMI 2.1** — 48 Gbit/s. Also requires a certified Ultra High Speed cable; an older cable
  that physically fits will negotiate down to 2.0 speeds.
- **DSC** (Display Stream Compression) is visually lossless in practice. Its real cost is
  occasional mode-switching quirks and blank periods when waking from sleep.

Verify what you actually got in the OS display settings after plugging in, every time. A
cable that works is not the same as a cable that works at full specification.

## Ergonomics, which I underweighted for years

Top of the screen at or slightly below eye level. Arm's length away. A monitor arm is
cheaper than the physiotherapy and frees the desk underneath.

Matte coating over glossy for a room with a window behind you. Glossy has better perceived
contrast in a controlled dark room and is unusable next to daylight.

## Purchase note

27" 1440p 165 Hz IPS, 8 900 CZK. Lucie Šimková (lucie.simkova@example.com) has the 32" 4K
version of the same panel family and thinks I under-bought. She works in photographs and I
work in text, which is most of the disagreement.
