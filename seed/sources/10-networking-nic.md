# Networking notes — NIC, Wi-Fi and latency

## Wired: the controller matters more than the speed

Nearly every current board includes **2.5GbE**. Two controllers dominate, and they are not
equivalent.

- **Realtek RTL8125** — inexpensive, ubiquitous, and the source of most of the "my connection
  drops under load" reports I've read. Driver quality has improved considerably; the hardware
  offload capabilities are still thinner, so more work lands on the CPU.
- **Intel I226-V** — the better silicon, and worth naming specifically when comparing boards.
  Early stepping revisions had a documented issue with dropped links on certain switches,
  fixed in later revisions and firmware. Check the revision on a board you're buying today.

For anything more than 2.5GbE, an add-in card is the route. A 10GbE card wants PCIe 3.0 x4 —
which on my board would come off the chipset, and per my motherboard note, everything behind
the chipset shares one four-lane uplink to the CPU. A 10GbE card and two busy NVMe drives on
the same uplink will contend.

## Do you actually need faster than gigabit?

Honest answer for a home machine: usually not, and the exception is specific.

- Internet connection slower than 1 Gbit/s — the WAN link is the limit and the NIC is
  irrelevant.
- File transfers to a NAS — this is the real case. Moving large files at 2.5GbE is roughly
  2.5× faster than gigabit, and if the NAS has SSD storage the difference is fully realised.
  With spinning disks on the far end, the drives become the limit around 150–200 MB/s and the
  faster link buys nothing.
- Gaming — no. Bandwidth has essentially nothing to do with it; latency does.

## Wi-Fi standards

- **Wi-Fi 6 (802.11ax)** — the meaningful generational step. OFDMA and better scheduling made
  congested environments far better, which matters more than peak throughput.
- **Wi-Fi 6E** — Wi-Fi 6 plus the 6 GHz band. The band is the point: it's empty compared with
  2.4 and 5 GHz, so in a block of flats with thirty visible networks the improvement is
  dramatic. Range through walls is worse — 6 GHz attenuates more than 5 GHz.
- **Wi-Fi 7 (802.11be)** — 320 MHz channels, 4K-QAM, and **MLO** (multi-link operation),
  which lets a client use two bands simultaneously rather than picking one. MLO is the
  genuinely interesting feature: it improves reliability and latency consistency, not just
  peak numbers.

Both ends have to support a feature for it to exist. A Wi-Fi 7 card with a Wi-Fi 5 router is
a Wi-Fi 5 connection.

## Latency, which is what people actually mean

"Slow internet" during gaming or calls is almost always latency and jitter, not bandwidth.

The dominant cause on a home connection is **bufferbloat**: an oversized buffer somewhere in
the path absorbs a burst instead of dropping packets, and latency under load climbs from 20 ms
to several hundred. Anything interactive falls apart while a large upload runs.

The fix is queue management on the router — **fq_codel** or **CAKE** — configured with your
actual line rate. It works by deliberately keeping queues short. On my connection this took
worst-case loaded latency from around 340 ms to under 30 ms, which was a far larger
improvement to how the connection *feels* than doubling its bandwidth would have been.

Test it with a loaded-latency test rather than a plain speed test; a plain speed test reports
the number that isn't the problem.

## Wired versus wireless for interactive work

Wi-Fi 6E and 7 have narrowed the gap in throughput. They have not closed it in *consistency* —
wireless latency varies with interference, and the variance is what breaks calls and games.
For a desktop that doesn't move, cable it. The port is already on the board.

## Small practical notes

- Cat 6 is sufficient for 2.5GbE and 10GbE at domestic distances. Cat 8 in a flat is money
  spent on a longer number.
- Onboard NICs die from surges — a nearby lightning strike took out a board's port and left
  the rest of the machine intact. A cheap add-in card resurrected it. Worth knowing before
  replacing a board over one dead port.
- Wake-on-LAN is configured in two places, the BIOS and the OS adapter properties, and needs
  both. Also frequently defeated by the OS's fast-startup setting.

## Contacts

David Kraus (david.kraus@example.com, +420 603 456 789) set up the CAKE configuration on my
router and is the reason the bufferbloat section exists. He measures things properly rather
than repeating forum advice, which makes him worth more than a review site.
