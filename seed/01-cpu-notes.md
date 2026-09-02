# CPU notes

Running notes on processors — sockets, how the power numbers actually behave, and the
mistakes I've already made once and don't want to repeat.

## Sockets and what they lock you into

The socket is the decision you live with longest. Everything else in the machine can be
swapped in an evening; the socket decides whether "swapped" means a new motherboard too.

- **AM5** (AMD, LGA 1718) — land grid array, so the pins are on the board now, not the chip.
  AMD committed to supporting it into 2027, which is the main reason I picked it for the
  desktop. DDR5 only. There is no DDR4 fallback, so an AM5 build is also a memory purchase.
- **LGA 1851** (Intel, Arrow Lake generation) — replaced LGA 1700. Same cooler mounting
  dimensions as 1700, which saved me buying a new cooler, but the chipsets and the socket
  itself are not cross-compatible.
- **LGA 1700** (Intel, 12th–14th gen) — still everywhere on the second-hand market. Fine
  value if you accept that it's a dead-end platform for upgrades.

The practical rule I've settled on: if a platform is in its final year, buy the best CPU
that socket will ever take, or don't buy the socket at all. Buying a cheap chip on a dead
socket "to upgrade later" is the trap — later never comes at a good price.

## Core types are not all the same core

Modern desktop CPUs are not uniform any more. Intel splits into P-cores (performance,
hyper-threaded on most generations) and E-cores (efficient, no SMT, smaller, clustered
in groups of four sharing L2). AMD does something different: all cores are full cores, but
on dual-CCD parts they're split across two chiplets, and crossing between chiplets costs
latency.

Why this matters for anything I actually do:

- A game that expects "8 fast cores" can get scheduled onto E-cores and lose double-digit
  percentages of frame rate. Windows' thread director usually gets it right, but not always.
- On dual-CCD AMD parts, a workload that fits in one CCD is often *faster* than one spread
  across both, because it stops paying the cross-chiplet hop. This is why the X3D parts with
  the big cache on one CCD behave the way they do.
- For compiles and renders, none of this matters much — throughput work is happy to use
  every core it's given.

## TDP is a cooling spec, not a power draw

This is the number I misread for years. TDP is what the cooler has to be able to dissipate
under a sustained nominal load. It is not the peak the chip pulls from the wall.

- On AMD, the number that actually caps sustained draw is **PPT** (package power tracking),
  and it runs roughly 1.35× the rated TDP. A 105 W part sits at about 142 W PPT; a 170 W
  part at about 230 W.
- On Intel, there are two: **PL1** (sustained) and **PL2** (boost). Many boards ship with
  PL2 effectively unlimited by default, so a "125 W" chip will happily pull well past 250 W
  in a sustained all-core load until it hits a thermal limit. This is a motherboard vendor
  decision, not an Intel one, and it's the single most common reason a build runs hotter
  than the spec sheet suggested.

So when I size a cooler, I size it for PPT or PL2, never for TDP. And when I size a PSU, I
budget the CPU's real ceiling — see my PSU sizing note for how that adds up.

## Boost behaviour

Boost clocks are opportunistic and every one of these will pull them down: package
temperature, current limits, how many cores are loaded, and on AMD, the fabric clock. The
advertised single-core boost is a best case that assumes a cold chip and one busy thread.
Seeing it briefly at idle-ish load and never again under real work is normal, not a defect.

Undervolting (AMD Curve Optimizer, or a negative offset on Intel) is the highest-value
tuning I know. Less voltage at the same frequency means less heat, which means the chip
stays under its thermal limit longer, which means it holds boost longer. I gained
performance by *reducing* power on both of my last two builds. It takes an evening of
stability testing to find the curve, and it's worth it.

## Buying notes

Marek Dvořák at the shop on Veveří quoted me 8 900 CZK for the mid-range AM5 part in
March, which was about 600 CZK over the online price but included fitting the cooler and a
72-hour burn-in — worth it that time because I didn't own a torque driver yet. His direct
line is +420 601 234 567 if I need another quote, and he answers email at
marek.dvorak@example.com faster than he answers the phone.

Petra Horáková warned me off the cheapest B-series board for a high-PPT chip and she was
right — see the motherboard note on VRM thermals. Her advice cost me nothing and saved me a
board.

## Things I got wrong

- Bought a cooler rated "up to 150 W" for a 142 W PPT chip. Technically adequate, thermally
  miserable — those ratings assume an open bench and a 22 °C room.
- Assumed the stock cooler in the box was a placeholder. On the lower-TDP parts it's
  genuinely fine. On anything above about 65 W it isn't.
- Enabled every boost setting the board offered at once, then spent two evenings finding out
  which one was causing the WHEA errors. Change one thing at a time.
