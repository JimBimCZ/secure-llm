# PSU sizing notes

The component where being cheap has the widest blast radius. Everything else fails alone; a
supply can take other parts with it.

## The arithmetic I actually use

Add the real ceilings, not the marketing numbers:

| Item | Figure to use | My build |
|---|---|---|
| CPU | PPT or PL2, never TDP | 142 W |
| GPU | Rated total board power | 320 W |
| Motherboard, memory, fans | Flat allowance | ~60 W |
| NVMe drives | ~8 W each under load | 16 W |
| **Sum** | | **~540 W** |

Then the part people skip: **do not buy a 550 W supply for a 540 W load.**

Two independent reasons to go higher:

1. **Efficiency peaks near 50% load.** A supply run at 90% of its rating is at its least
   efficient, hottest, and loudest point. Sitting near half load means the fan often doesn't
   spin at all.
2. **Transient spikes.** This is the one that actually breaks machines. As recorded in my GPU
   note, a modern card can pull roughly **twice its rated board power for about a
   millisecond** during load transitions. For a 320 W card that's an excursion toward 600 W
   on its own, on top of whatever the CPU is doing at that instant.

I bought **850 W** for a ~540 W build. That's not paranoia, it's the second row of that list.

## Why the transient thing matters more than the average

A supply whose average headroom is comfortable can still shut down, because over-current
protection responds to the spike, not the average. The symptom is maddening to diagnose:
instant reboot or hard power-off under load, no blue screen, nothing in the event log,
because the machine lost power faster than it could write anything. It looks exactly like a
memory fault or a driver problem, and people replace the wrong parts for weeks.

**ATX 3.1** exists to address this. A compliant supply must ride through excursions to 200%
of rated power for 100 µs and 180% for 1 ms without shutting down. If you're pairing a
current graphics card with a supply, this compliance is more valuable than an extra
efficiency tier.

## Efficiency ratings

80 PLUS Bronze / Gold / Platinum / Titanium describe efficiency at various loads. Gold is the
sensible default; Platinum and Titanium have long payback periods at domestic electricity
prices and are bought for heat and noise rather than for the electricity bill.

What the rating does **not** describe: ripple, hold-up time, protection circuitry quality, or
capacitor grade. Two Gold units can be very different supplies. The badge is a floor, not a
review — this is a category where reading an actual teardown review of the specific model is
worth twenty minutes.

## Cables

- **Never reuse a modular cable from a different supply.** The connector on the PSU side is
  not standardised between manufacturers, or even between ranges from the same manufacturer.
  A cable that physically fits can deliver 12 V to a pin expecting ground. This destroys
  hardware and is the single most expensive mistake available in a build.
- Use separate PCIe cables for separate connectors on a high-draw card rather than daisy-
  chaining one cable's two ends, if the supply provides enough. The daisy-chain is within
  spec, but it puts the whole card's draw through one set of wires.
- The 12V-2x6 handling rules are in my GPU note and they are not optional.

## Age

Electrolytic capacitors dry out. A supply that was excellent in 2016 is not delivering its
original figures now, particularly if it lived somewhere warm. I replace at roughly ten
years regardless of apparent health, and I don't move an old supply into a new build to save
money — that's putting the oldest component in the position of most leverage.

## Sizing for what you'll build next

The supply outlives two or three graphics cards. Budgeting a little headroom for a future,
hungrier card is the one place in a build where buying for the future genuinely pays,
because unlike a socket or a memory standard, wattage doesn't become obsolete.

## Purchase note

850 W ATX 3.1 Gold, fully modular, ten-year warranty, 3 400 CZK. David Kraus
(david.kraus@example.com) had measured this exact model's transient behaviour on his bench
and sent me the traces, which is why I bought it over the cheaper unit with the same badge.
His summary was that the badge told you nothing and the hold-up time told you everything.
