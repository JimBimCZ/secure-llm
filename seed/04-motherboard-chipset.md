# Motherboard and chipset notes

The board is the least exciting purchase and the one that quietly decides what the rest of
the build can do.

## What the chipset actually buys you

The CPU provides a fixed set of PCIe lanes directly — on current AM5 parts, 24 usable lanes.
Those are the fast ones: they go straight to the processor with no intermediary. The chipset
is a separate silicon package that hangs off a small number of those CPU lanes (four, on
this platform) and fans them out into many more downstream lanes.

The consequence people miss: **chipset lanes are shared**. Everything behind the chipset —
extra M.2 slots, SATA ports, most USB, the network interface, the audio codec — funnels
through that single four-lane uplink to the CPU. Individually each device is fine. All of
them busy at once and the uplink becomes the bottleneck. This is why copying between two
chipset-attached NVMe drives is slower than the drives' individual ratings suggest.

Tiers as I understand them on AM5:

- **A620** — budget. Usually no CPU overclocking, weaker VRM, fewer lanes and often PCIe 4.0
  only on the primary slot. Fine for a low-power chip, wrong for anything with a high PPT.
- **B650** — the sensible middle. Memory overclocking (EXPO), decent connectivity. **B650E**
  adds PCIe 5.0 on the primary graphics slot.
- **X670 / X670E** — two chipset packages daisy-chained for more downstream connectivity.
  More lanes, more ports, more money. Worth it only if you're actually filling them.

I bought a B650. For a two-drive, one-GPU machine there was nothing on the X670 feature list
I would have used.

## Reading the block diagram before buying

Every manual has a block diagram showing which slot hangs off what. It is the single most
useful page in the document and almost nobody opens it. Read it before ordering, because the
lane arithmetic is where the unpleasant surprises live.

On my board the diagram shows the primary x16 graphics slot wired directly to the CPU, the
first M.2 slot on four CPU lanes, and **the second M.2 slot running at PCIe 4.0 x4 off the
chipset** — so on paper, populating that second slot costs the graphics card nothing. That
was the reason I chose this board over the cheaper one, which multiplexes its second M.2 with
the graphics slot and drops it to x8.

I want to flag that I later saw behaviour that contradicts this, and I have not fully
reconciled it. The details are in my storage note. Take the paragraph above as what the
manual says, not as verified fact.

## VRM — the part that separates cheap boards from adequate ones

The voltage regulator module converts 12 V from the supply into the roughly 1.1–1.4 V the CPU
wants, at over a hundred amps. Doing that badly generates heat, and the failure mode isn't a
dead board — it's a board that quietly throttles the CPU to protect itself, so you lose
performance you paid for and nothing tells you why.

What to look for:

- **Phase count** matters less than marketing implies, and phase *quality* more. An honest
  8-phase design with real 60 A power stages beats a "16-phase" arrangement that's actually
  eight phases doubled.
- **Heatsink mass and airflow across it.** Many VRM heatsinks are decorative. In a build with
  an AIO cooler there is no fan blowing over that area at all, unlike with a tower air cooler
  — which is an underrated argument for air cooling on a hot chip.
- Petra Horáková's rule, which I now follow: match the board tier to the CPU's PPT, not to
  the CPU's name. A 230 W PPT part on an entry board is a throttling machine.

## BIOS, and the things that bite

- **Update before installing a new-generation CPU.** A board manufactured before that CPU
  existed may not POST with it at all. Most current boards have a USB BIOS flashback feature
  that flashes from a USB stick with no CPU or memory installed — check for that button
  before buying, because without it you need a borrowed older CPU to recover.
- Every BIOS update resets settings to default. Photograph your tuned pages first. I have
  lost a memory configuration this way and had to re-derive it from the log.
- Vendor "optimised defaults" are frequently not optimised for anything but benchmark
  numbers — unlimited power limits, aggressive memory training. Reasonable starting point,
  bad ending point.

## Form factor

ATX, micro-ATX and mini-ITX, in descending size and ascending compromise. Mini-ITX takes two
DIMM slots and usually one M.2, and everything inside is harder to reach. Micro-ATX is the
underrated middle: nearly all of the connectivity, meaningfully cheaper, fits more cases.

Physical check before ordering, learned the expensive way: measure the CPU cooler's height
against the case, the graphics card's length against the drive cage, and the memory heat
spreader's height against the cooler's overhang. See the case and airflow note.

## Purchase record

Board came from Marek Dvořák (marek.dvorak@example.com) for 4 800 CZK, with the BIOS already
flashed to current, which is a service worth paying for given the flashback situation above.
