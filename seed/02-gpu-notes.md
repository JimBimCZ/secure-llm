# GPU notes

Graphics cards — what the specs mean, what actually limits them, and the connector saga.

## VRAM is the spec that ages worst

Core performance degrades gracefully: an older card just runs at lower settings. VRAM does
not degrade gracefully. When a card runs out of memory it doesn't get slower in proportion,
it falls off a cliff — stutter, texture pop-in, or an outright crash.

Rough working numbers I use:

- **8 GB** — fine at 1080p today, already marginal at 1440p with high textures. I would not
  buy 8 GB again for a card I expect to keep three years.
- **12 GB** — comfortable at 1440p. This is the sensible floor now.
- **16 GB** — the point where 4K stops being the constraint and the core does.
- **24 GB and up** — only justified by local model work or heavy 3D. For gaming it is
  headroom I have never actually consumed.

Ray tracing and frame generation both cost extra VRAM on top of the base render. A card
that's exactly adequate without them becomes inadequate with them switched on, which is a
nasty surprise given they're marketed as free performance.

## PCIe lanes and bandwidth

A discrete card wants a full **x16 slot off the CPU**. What it actually gets depends on the
board, and this is where I lost a weekend — see the storage note, because populating a
second M.2 drive is what triggered my problem.

Bandwidth per generation, x16 link, one direction:

| Generation | Per lane | x16 total |
|---|---|---|
| PCIe 3.0 | ~1 GB/s | ~16 GB/s |
| PCIe 4.0 | ~2 GB/s | ~32 GB/s |
| PCIe 5.0 | ~4 GB/s | ~64 GB/s |

The useful thing to know: for most cards, dropping from x16 to x8 on the *same* generation
costs low single-digit percentages, because games rarely saturate the link. The exception
is a card with too little VRAM — once it starts swapping textures across the bus, link width
suddenly matters a great deal. So a narrow link punishes exactly the cards least able to
absorb it.

## Transient spikes — the number that catches people out

This is the most important thing on this page. A modern high-end card does **not** draw its
rated board power smoothly. Under load transitions it produces short excursions well above
the rating: roughly **up to 2× rated board power for around 1 ms**, with smaller excursions
lasting longer.

A 320 W card can therefore momentarily demand something in the region of 600 W. The card
averages fine; the PSU's over-current protection sees the spike. A supply that is nominally
adequate on average will trip and shut the machine down mid-load, and the symptom looks like
an unrelated instability — instant reboot, no blue screen, nothing in the event log.

This is the whole reason the ATX 3.x specification exists, and the whole reason I over-spec
supplies. The arithmetic is in my PSU sizing note.

## The 12V-2x6 connector

The original 12VHPWR connector had a genuine problem: if it wasn't fully seated, the
contacts carried current across a partial connection and generated heat, in a few cases
enough to melt the housing. The revised **12V-2x6** shortens the sense pins so an incompletely
seated plug doesn't get permission to draw full power — a design fix for a human-error
problem, which is the right way round.

Handling rules I follow without exception:

1. Push until the latch clicks, then look at it side-on to confirm it's flush. "Felt about
   right" is how the failures happened.
2. Keep the cable straight for at least 35 mm before any bend. Bending immediately at the
   connector body puts lateral load on the contacts.
3. Use the native cable from the supply, not a third-party one bought on colour. Pinouts on
   the PSU side are not standardised between vendors and an incorrect cable can be genuinely
   dangerous.
4. Recheck it after moving the case. Transport loosens things.

## Undervolting

Same logic as the CPU: cards ship with voltage headroom for the worst silicon in the batch,
and mine is usually not the worst. A modest undervolt typically holds within a couple of
percent of stock performance while cutting 15–20% of the power, which drops fan speed and
temperature with it. On a card with transient behaviour like the above, it also shrinks the
spikes, which is the quiet second benefit.

## RMA experience, for the record

The first card I bought developed artefacts under load after five weeks. Tomáš Bednář
handled the case, reachable at tomas.bednar@example.com, and the replacement took eleven
days door to door. Useful thing I learned: photograph the card's serial and the original
packaging label *before* sending it, because the courier lost the outer box and the claim
would have been unwinnable otherwise. The support line +420 602 345 678 is answered by
someone technical, unusually.

## Buying notes

Reviews are conducted at settings I don't use, on a test bench with unlimited airflow. The
number that matters to me is sustained clock after twenty minutes in a closed case, and
almost nobody publishes it. Where I can find one, I trust a thermal-throttling graph over a
frame-rate bar chart.

Card length and slot height are worth measuring against the case before ordering, not after.
See my case and airflow note — I have made this mistake.
