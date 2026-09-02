# Storage notes — NVMe, SSDs, and the lane mystery

## Generations and what the speed numbers are worth

| Interface | Sequential read, typical | Reality |
|---|---|---|
| SATA III | ~550 MB/s | The protocol is the limit, not the flash |
| PCIe 3.0 x4 | ~3 500 MB/s | Still entirely adequate for a boot drive |
| PCIe 4.0 x4 | ~7 000 MB/s | The current sensible default |
| PCIe 5.0 x4 | ~14 000 MB/s | Fast, hot, and rarely the bottleneck |

The honest observation after owning all four: past PCIe 3.0, **sequential speed stopped
being something I can feel**. Booting, launching applications and loading games are dominated
by small random reads at low queue depth, and that figure has improved far less dramatically
between generations than the headline number suggests. A Gen5 drive is roughly four times the
sequential of a Gen3 drive and perhaps a third faster where it counts.

Where Gen5 does earn its money: moving very large files, working with video, and loading
large model weights off disk. Otherwise it is a number for the box.

## DRAM-less drives and HMB

Cheaper drives omit the onboard DRAM cache that stores the flash translation layer mapping,
and instead borrow a slice of system memory over **HMB** (host memory buffer), typically
32–64 MB. For light use this is genuinely fine. Under sustained random writes, or when the
drive is nearly full, the difference against a DRAM-equipped drive becomes obvious and
unpleasant.

My rule: DRAM-less is acceptable for a bulk/media drive, not for the drive the operating
system lives on.

## SLC cache — the cliff

Consumer TLC and QLC drives write a portion of their flash in fast single-bit mode as a
cache, then fold it down in the background. Sustained writes larger than that cache fall off
a cliff: a drive rated 7 000 MB/s can drop to **a few hundred MB/s**, and on QLC sometimes
below hard-drive speeds.

Two things make the cliff worse: a full drive (less spare flash available to run as cache)
and a hot drive. Keeping roughly 20% free is the cheapest performance tuning available.

## Endurance

Rated in TBW — terabytes written over the warranty. A 1 TB consumer TLC drive is typically
rated around 600 TBW. I checked my own after two years of ordinary use: 18 TB. At that rate
the warranty expires roughly seventy years before the endurance does. **Endurance is not
what kills consumer SSDs** — controller failure and firmware bugs are, and neither is
predictable from a spec sheet. Which is the argument for backups rather than for buying
higher-endurance flash.

## Thermals

Gen4 drives run warm; Gen5 drives run hot enough that several ship with their own fans. They
throttle at roughly 70–80 °C, and the throttle is aggressive — performance drops by half
rather than tapering.

The M.2 slot underneath a graphics card is the worst thermal position in the case, and it is
frequently the primary slot. Board-supplied M.2 heatsinks are worth using; they're usually
adequate and already paid for.

## The lane mystery — unresolved contradiction

Documented properly because it contradicts what I wrote in my motherboard note, and I don't
want to quietly forget it.

**What the manual says:** the second M.2 slot on this B650 board runs PCIe 4.0 x4 off the
chipset, independent of the graphics slot. That was my reason for choosing this board.

**What actually happened:** I installed a second NVMe drive in that slot. On the next boot,
GPU-Z reported the graphics card at **x8** instead of x16. Removing the drive returned it to
x16, reproducibly, three times.

So either the block diagram is wrong, or something else changed at the same time. Candidates
I have not yet eliminated:

- The BIOS update I applied in the same session may have changed a lane-allocation default.
- Some boards expose a manual PCIe bifurcation setting that overrides the physical wiring.
- GPU-Z reports the *current* link state, and cards drop to x8 at idle to save power. I did
  not confirm the reading under load, which in hindsight is the obvious flaw in my testing.

The third is the most likely and the most embarrassing. **Test again under load before
believing either document.** Measured impact on frame rate was within noise, which is
consistent with everything in my GPU note about link width, so the practical cost was zero
regardless.

## Backups, briefly

An SSD fails without the warning noises a hard drive gives. Three copies, two media, one
off-site. I run a nightly local snapshot and a weekly encrypted upload; Lucie Šimková
(lucie.simkova@example.com) audits hers quarterly by actually restoring a file, which is the
part everyone skips and the only part that proves anything.
